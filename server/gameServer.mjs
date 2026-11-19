import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ============================================================================
 * Chroma Strike — Zero-Dependency 6-Player Tactical WebSocket Server (RFC 6455)
 * ============================================================================
 * Built exclusively on Node.js built-ins (`node:http`, `node:crypto`).
 *
 * Hard Constraints:
 *  - MAX_PLAYERS  = 6 (7th simultaneous connection receives SERVER_FULL + close 4000)
 *  - MAX_PER_TEAM = 3 (Attackers 0..2, Defenders 0..2)
 *  - Phases: 'lobby' -> 'agent_select' -> 'playing'
 *  - Health endpoint: GET /health -> 200 OK JSON + CORS
 */

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_PORT = 5174;
export const MAX_PLAYERS = 6;
export const MAX_PER_TEAM = 3;
export const SWAP_INTERVAL = 5;

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const AGENT_COLORS = ['red', 'blue', 'green', 'violet', 'gold'];
const VALID_SIDES = new Set(['attacker', 'defender']);
const VALID_DIFFICULTIES = new Set(['casual', 'tactical', 'pro']);
const VALID_WIN_TARGETS = new Set([10, 6]);

// ---------------------------------------------------------------------------
// RFC 6455 WebSocket Frame Encoder & Parser
// ---------------------------------------------------------------------------

/**
 * Encodes an unmasked server-to-client RFC 6455 frame supporting <=125,
 * 16-bit (126), and 64-bit (127) payload lengths.
 */
export function encodeWsFrame(opcode, payload = Buffer.alloc(0)) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = buf.length;
  const firstByte = 0x80 | (opcode & 0x0f);

  let header;
  if (len <= 125) {
    header = Buffer.allocUnsafe(2);
    header[0] = firstByte;
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = firstByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, buf]);
}

export function encodeClosePayload(code = 1000, reason = '') {
  const reasonBuf = Buffer.from(reason, 'utf8');
  const out = Buffer.allocUnsafe(2 + reasonBuf.length);
  out.writeUInt16BE(code & 0xffff, 0);
  reasonBuf.copy(out, 2);
  return out;
}

function safeWrite(socket, buffer) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(buffer);
    return true;
  } catch {
    return false;
  }
}

function sendJson(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  return safeWrite(socket, encodeWsFrame(0x1, payload));
}

function sendClose(socket, code = 1000, reason = '') {
  if (!socket || socket.destroyed) return;
  const closeFrame = encodeWsFrame(0x8, encodeClosePayload(code, reason));
  if (socket.writable && !socket.writableEnded) {
    try {
      socket.end(closeFrame);
    } catch {
      if (!socket.destroyed) socket.destroy();
      return;
    }
  } else {
    if (!socket.destroyed) socket.destroy();
    return;
  }
  const timer = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, 250);
  if (typeof timer.unref === 'function') timer.unref();
}

function sendPong(socket, payload = Buffer.alloc(0)) {
  return safeWrite(socket, encodeWsFrame(0xA, payload));
}

/**
 * Creates a stateful RFC 6455 frame reader for one TCP socket.
 * Handles chunk boundaries, coalesced frames, masking, fragmentation,
 * ping/pong, and close frames.
 */
function attachWsFrameParser(socket, handlers) {
  let recvBuffer = Buffer.alloc(0);
  let fragOpcode = null;
  let fragChunks = [];
  let fragTotalLen = 0;

  function consume(chunk) {
    if (!chunk || chunk.length === 0) return;
    recvBuffer = recvBuffer.length === 0 ? chunk : Buffer.concat([recvBuffer, chunk]);

    while (recvBuffer.length >= 2) {
      const b0 = recvBuffer[0];
      const b1 = recvBuffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (recvBuffer.length < offset + 2) return;
        payloadLen = recvBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (recvBuffer.length < offset + 8) return;
        const bigLen = recvBuffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(MAX_PAYLOAD_BYTES)) {
          sendClose(socket, 1009, 'Message too large');
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      if (payloadLen > MAX_PAYLOAD_BYTES) {
        sendClose(socket, 1009, 'Message too large');
        return;
      }

      let maskKey = null;
      if (masked) {
        if (recvBuffer.length < offset + 4) return;
        maskKey = recvBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (recvBuffer.length < offset + payloadLen) return;

      const rawPayload = Buffer.from(recvBuffer.subarray(offset, offset + payloadLen));
      recvBuffer = recvBuffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < rawPayload.length; i++) {
          rawPayload[i] ^= maskKey[i & 3];
        }
      }

      // Control frames (0x8 close, 0x9 ping, 0xA pong)
      if (opcode === 0x8) {
        let closeCode = 1000;
        if (rawPayload.length >= 2) {
          closeCode = rawPayload.readUInt16BE(0);
        }
        handlers.onClose?.(closeCode);
        sendClose(socket, 1000, 'Normal closure');
        return;
      }

      if (opcode === 0x9) {
        sendPong(socket, rawPayload);
        continue;
      }

      if (opcode === 0xA) {
        handlers.onPong?.();
        continue;
      }

      // Data frames (text 0x1, binary 0x2, continuation 0x0)
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          if (opcode === 0x1) {
            handlers.onText?.(rawPayload.toString('utf8'));
          }
        } else {
          fragOpcode = opcode;
          fragChunks = [rawPayload];
          fragTotalLen = rawPayload.length;
        }
      } else if (opcode === 0x0) {
        if (fragOpcode === null) {
          sendClose(socket, 1002, 'Unexpected continuation frame');
          return;
        }
        fragTotalLen += rawPayload.length;
        if (fragTotalLen > MAX_PAYLOAD_BYTES) {
          sendClose(socket, 1009, 'Fragmented message too large');
          return;
        }
        fragChunks.push(rawPayload);
        if (fin) {
          const full = Buffer.concat(fragChunks);
          const doneOpcode = fragOpcode;
          fragOpcode = null;
          fragChunks = [];
          fragTotalLen = 0;
          if (doneOpcode === 0x1) {
            handlers.onText?.(full.toString('utf8'));
          }
        }
      } else {
        sendClose(socket, 1002, 'Unsupported opcode');
        return;
      }
    }
  }

  socket.on('data', consume);
  return { consume };
}

// ---------------------------------------------------------------------------
// 6-Player Room State Machine & Server Factory
// ---------------------------------------------------------------------------

export function createGameServer(options = {}) {
  const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const silent = Boolean(options.silent);

  let nextClientNum = 1;

  /** @type {Map<string, { id: string, socket: import('node:net').Socket }>} */
  const connections = new Map();
  /** @type {Set<import('node:net').Socket>} */
  const liveSockets = new Set();

  const room = {
    phase: 'lobby', // 'lobby' | 'agent_select' | 'playing'
    hostId: null,
    difficulty: 'casual',
    winTarget: 10,
    swapInterval: SWAP_INTERVAL,
    autoFillBots: true,
    /**
     * @type {Array<{
     *   id: string,
     *   name: string,
     *   side: 'attacker' | 'defender',
     *   slotIndex: 0 | 1 | 2,
     *   agentColor: 'red' | 'blue' | 'green' | 'violet' | 'gold',
     *   lockedIn: boolean,
     *   isHost: boolean
     * }>}
     */
    players: [],
  };

  function getPlayersOnSide(side) {
    return room.players.filter((p) => p.side === side);
  }

  function findOpenSlotIndex(side) {
    const used = new Set(getPlayersOnSide(side).map((p) => p.slotIndex));
    for (let i = 0; i < MAX_PER_TEAM; i++) {
      if (!used.has(i)) return i;
    }
    return null;
  }

  function pickNonConflictingColor(side, excludePlayerId = null, preferred = null) {
    const taken = new Set(
      room.players
        .filter((p) => p.side === side && p.id !== excludePlayerId)
        .map((p) => p.agentColor)
    );
    if (preferred && AGENT_COLORS.includes(preferred) && !taken.has(preferred)) {
      return preferred;
    }
    for (const c of AGENT_COLORS) {
      if (!taken.has(c)) return c;
    }
    return AGENT_COLORS[0];
  }

  function isColorTakenOnSide(side, color, excludePlayerId) {
    return room.players.some(
      (p) => p.side === side && p.id !== excludePlayerId && p.agentColor === color
    );
  }

  function deduplicateTeamColors() {
    for (const side of ['attacker', 'defender']) {
      const used = new Set();
      for (const p of getPlayersOnSide(side)) {
        if (!AGENT_COLORS.includes(p.agentColor) || used.has(p.agentColor)) {
          const next = AGENT_COLORS.find((c) => !used.has(c)) ?? 'red';
          p.agentColor = next;
        }
        used.add(p.agentColor);
      }
    }
  }

  function getLobbySnapshot() {
    return {
      phase: room.phase,
      hostId: room.hostId,
      difficulty: room.difficulty,
      winTarget: room.winTarget,
      swapInterval: room.swapInterval,
      autoFillBots: room.autoFillBots,
      maxPlayers: MAX_PLAYERS,
      maxPerTeam: MAX_PER_TEAM,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        side: p.side,
        slotIndex: p.slotIndex,
        agentColor: p.agentColor,
        lockedIn: p.lockedIn,
        isHost: p.id === room.hostId,
      })),
    };
  }

  function broadcast(message, excludeId = null) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const frame = encodeWsFrame(0x1, payload);
    for (const [id, conn] of connections.entries()) {
      if (excludeId && id === excludeId) continue;
      safeWrite(conn.socket, frame);
    }
  }

  function broadcastLobbyState() {
    broadcast({ type: 'lobby_state', state: getLobbySnapshot() });
  }

  function sendError(socket, code, message) {
    sendJson(socket, { type: 'error', code, message });
  }

  function getPlayerById(id) {
    return room.players.find((p) => p.id === id) ?? null;
  }

  function sanitizeName(rawName, fallbackNum) {
    if (typeof rawName !== 'string') return `AGENT-${fallbackNum}`;
    const cleaned = rawName.trim().replace(/[^\w\s\-().]/g, '').slice(0, 20);
    return cleaned.length > 0 ? cleaned : `AGENT-${fallbackNum}`;
  }

  function chooseOpenSide(preferredSide) {
    const atkCount = getPlayersOnSide('attacker').length;
    const defCount = getPlayersOnSide('defender').length;

    if (preferredSide && VALID_SIDES.has(preferredSide)) {
      if (preferredSide === 'attacker' && atkCount < MAX_PER_TEAM) return 'attacker';
      if (preferredSide === 'defender' && defCount < MAX_PER_TEAM) return 'defender';
    }
    if (atkCount <= defCount && atkCount < MAX_PER_TEAM) return 'attacker';
    if (defCount < MAX_PER_TEAM) return 'defender';
    if (atkCount < MAX_PER_TEAM) return 'attacker';
    return null;
  }

  function handleJoin(clientId, socket, msg, clientNum) {
    const existing = getPlayerById(clientId);
    const name = sanitizeName(msg.name, clientNum);

    if (existing) {
      existing.name = name;
      if (
        room.phase === 'lobby' &&
        msg.preferredSide &&
        VALID_SIDES.has(msg.preferredSide) &&
        msg.preferredSide !== existing.side
      ) {
        const openSlot = findOpenSlotIndex(msg.preferredSide);
        if (openSlot !== null) {
          existing.side = msg.preferredSide;
          existing.slotIndex = openSlot;
          existing.agentColor = pickNonConflictingColor(
            existing.side,
            existing.id,
            existing.agentColor
          );
        }
      }
      const state = getLobbySnapshot();
      sendJson(socket, { type: 'welcome', playerId: clientId, state });
      broadcastLobbyState();
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      sendError(socket, 'SERVER_FULL', 'Server full (6/6 players max)');
      sendClose(socket, 4000, 'Server full (6/6 players max)');
      return;
    }

    const side = chooseOpenSide(msg.preferredSide);
    if (!side) {
      sendError(socket, 'SERVER_FULL', 'Server full (6/6 players max)');
      sendClose(socket, 4000, 'Server full (6/6 players max)');
      return;
    }

    const slotIndex = findOpenSlotIndex(side);
    if (slotIndex === null) {
      sendError(socket, 'SERVER_FULL', 'Server full (6/6 players max)');
      sendClose(socket, 4000, 'Server full (6/6 players max)');
      return;
    }

    const isHost = room.hostId === null;
    if (isHost) {
      room.hostId = clientId;
    }

    const player = {
      id: clientId,
      name,
      side,
      slotIndex,
      agentColor: pickNonConflictingColor(side, clientId, msg.agentColor),
      lockedIn: false,
      isHost,
    };

    room.players.push(player);

    const state = getLobbySnapshot();
    sendJson(socket, { type: 'welcome', playerId: clientId, state });
    broadcast({ type: 'lobby_state', state });
  }

  function handleSwitchSide(clientId, socket, msg) {
    const player = getPlayerById(clientId);
    if (!player) {
      sendError(socket, 'NOT_JOINED', 'Join the lobby before switching sides');
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(socket, 'INVALID_PHASE', 'Sides can only be switched in the lobby');
      return;
    }
    const targetSide = msg.side;
    if (!VALID_SIDES.has(targetSide)) {
      sendError(socket, 'INVALID_SIDE', 'Side must be attacker or defender');
      return;
    }
    if (player.side === targetSide) {
      broadcastLobbyState();
      return;
    }

    const targetPlayers = getPlayersOnSide(targetSide);
    if (targetPlayers.length >= MAX_PER_TEAM) {
      const label = targetSide === 'attacker' ? 'Attackers' : 'Defenders';
      sendError(socket, 'TEAM_FULL', `${label} side is full (3/3 players)`);
      return;
    }

    const openSlot = findOpenSlotIndex(targetSide);
    if (openSlot === null) {
      sendError(socket, 'TEAM_FULL', 'Target team is full (3/3 players)');
      return;
    }

    player.side = targetSide;
    player.slotIndex = openSlot;
    player.agentColor = pickNonConflictingColor(targetSide, player.id, player.agentColor);
    player.lockedIn = false;
    broadcastLobbyState();
  }

  function handleSetConfig(clientId, socket, msg) {
    if (clientId !== room.hostId) {
      sendError(socket, 'NOT_HOST', 'Only the host can change match settings');
      return;
    }
    if (msg.difficulty !== undefined) {
      if (VALID_DIFFICULTIES.has(msg.difficulty)) {
        room.difficulty = msg.difficulty;
      }
    }
    if (msg.winTarget !== undefined) {
      const wt = Number(msg.winTarget);
      if (VALID_WIN_TARGETS.has(wt)) {
        room.winTarget = wt;
      }
    }
    if (msg.autoFillBots !== undefined) {
      room.autoFillBots = Boolean(msg.autoFillBots);
    }
    broadcastLobbyState();
  }

  function handleStartAgentSelect(clientId, socket) {
    if (clientId !== room.hostId) {
      sendError(socket, 'NOT_HOST', 'Only the host can launch Agent Select');
      return;
    }
    if (room.players.length === 0) {
      sendError(socket, 'NO_PLAYERS', 'No players in lobby');
      return;
    }
    room.phase = 'agent_select';
    for (const p of room.players) {
      p.lockedIn = false;
    }
    deduplicateTeamColors();
    broadcastLobbyState();
  }

  function transitionToPlaying() {
    deduplicateTeamColors();
    room.phase = 'playing';
    const state = getLobbySnapshot();
    broadcast({ type: 'lobby_state', state });
    broadcast({ type: 'match_start', state });
  }

  function handleSelectAgent(clientId, socket, msg) {
    const player = getPlayerById(clientId);
    if (!player) {
      sendError(socket, 'NOT_JOINED', 'Join the lobby first');
      return;
    }
    const color = msg.agentColor;
    if (!AGENT_COLORS.includes(color)) {
      sendError(socket, 'INVALID_AGENT', 'Unknown agent color');
      return;
    }
    if (isColorTakenOnSide(player.side, color, player.id)) {
      sendError(socket, 'AGENT_TAKEN', `${color.toUpperCase()} is already taken on your team`);
      return;
    }
    player.agentColor = color;
    if (room.phase === 'agent_select' && player.lockedIn) {
      player.lockedIn = false;
    }
    broadcastLobbyState();
  }

  function handleLockIn(clientId, socket, msg) {
    const player = getPlayerById(clientId);
    if (!player) {
      sendError(socket, 'NOT_JOINED', 'Join the lobby first');
      return;
    }
    if (room.phase !== 'agent_select') {
      sendError(socket, 'INVALID_PHASE', 'Lock-in is only available during Agent Select');
      return;
    }
    const color = msg.agentColor ?? player.agentColor;
    if (!AGENT_COLORS.includes(color)) {
      sendError(socket, 'INVALID_AGENT', 'Unknown agent color');
      return;
    }
    if (isColorTakenOnSide(player.side, color, player.id)) {
      sendError(socket, 'AGENT_TAKEN', `${color.toUpperCase()} is already locked on your team`);
      return;
    }

    player.agentColor = color;
    player.lockedIn = true;

    const allLocked = room.players.length > 0 && room.players.every((p) => p.lockedIn);
    if (allLocked) {
      transitionToPlaying();
    } else {
      broadcastLobbyState();
    }
  }

  function handleForceStart(clientId, socket) {
    if (clientId !== room.hostId) {
      sendError(socket, 'NOT_HOST', 'Only the host can force start the match');
      return;
    }
    for (const p of room.players) {
      p.lockedIn = true;
    }
    transitionToPlaying();
  }

  function handleReturnToLobby(clientId, socket) {
    if (clientId !== room.hostId) {
      sendError(socket, 'NOT_HOST', 'Only the host can return the room to lobby');
      return;
    }
    room.phase = 'lobby';
    for (const p of room.players) {
      p.lockedIn = false;
    }
    broadcastLobbyState();
  }

  function handleRelay(clientId, msg) {
    if (room.phase !== 'playing') return;
    const player = getPlayerById(clientId);
    if (!player) return;

    if (msg.type === 'player_state') {
      broadcast(
        {
          type: 'remote_state',
          playerId: player.id,
          name: player.name,
          side: msg.side && VALID_SIDES.has(msg.side) ? msg.side : player.side,
          slotIndex: player.slotIndex,
          agentColor: AGENT_COLORS.includes(msg.agentColor) ? msg.agentColor : player.agentColor,
          position: msg.position ?? { x: 0, y: 0, z: 0 },
          velocity: msg.velocity ?? { x: 0, y: 0, z: 0 },
          yaw: Number(msg.yaw) || 0,
          pitch: Number(msg.pitch) || 0,
          health: Number(msg.health) ?? 100,
          armor: Number(msg.armor) ?? 0,
          alive: msg.alive !== false,
          weaponId: msg.weaponId ?? 'pistol',
          firing: Boolean(msg.firing),
          sliding: Boolean(msg.sliding),
          ultActive: Boolean(msg.ultActive),
          timestampMs: Date.now(),
        },
        clientId
      );
      return;
    }

    if (
      msg.type === 'player_damage' ||
      msg.type === 'ability_cast' ||
      msg.type === 'door_event' ||
      msg.type === 'spike_event' ||
      msg.type === 'match_sync'
    ) {
      broadcast(
        {
          ...msg,
          fromId: player.id,
          timestampMs: Date.now(),
        },
        clientId
      );
    }
  }

  function handleDisconnect(clientId) {
    if (!connections.has(clientId)) return;
    connections.delete(clientId);

    const idx = room.players.findIndex((p) => p.id === clientId);
    if (idx === -1) return;

    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      room.phase = 'lobby';
      room.hostId = null;
      return;
    }

    if (room.hostId === clientId) {
      room.hostId = room.players[0].id;
      for (const p of room.players) {
        p.isHost = p.id === room.hostId;
      }
    }

    const state = getLobbySnapshot();
    broadcast({ type: 'player_left', playerId: clientId, state });
    broadcast({ type: 'lobby_state', state });

    if (room.phase === 'agent_select' && room.players.every((p) => p.lockedIn)) {
      transitionToPlaying();
    }
  }

  // -------------------------------------------------------------------------
  // HTTP + RFC 6455 Upgrade Server
  // -------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const urlPath = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && urlPath === '/health') {
      const body = JSON.stringify({
        ok: true,
        players: room.players.length,
        maxPlayers: MAX_PLAYERS,
        phase: room.phase,
      });
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(body);
      return;
    }

    res.writeHead(404, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    const upgradeHeader = String(req.headers['upgrade'] ?? '').toLowerCase();
    const wsKey = req.headers['sec-websocket-key'];

    if (upgradeHeader !== 'websocket' || typeof wsKey !== 'string' || wsKey.length === 0) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey.trim() + WS_GUID)
      .digest('base64');

    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
    );

    // Hard 6-Player Limit: reject 7th simultaneous connection immediately!
    if (connections.size >= MAX_PLAYERS) {
      socket.on('error', () => {
        if (!socket.destroyed) socket.destroy();
      });
      socket.on('end', () => {
        if (!socket.destroyed) {
          if (socket.writableEnded && !socket.writableFinished) {
            socket.once('finish', () => {
              if (!socket.destroyed) socket.destroy();
            });
          } else {
            socket.destroy();
          }
        }
      });
      sendError(socket, 'SERVER_FULL', 'Server full (6/6 players max)');
      sendClose(socket, 4000, 'Server full (6/6 players max)');
      return;
    }

    const clientNum = nextClientNum++;
    const clientId = `p-${clientNum}`;
    connections.set(clientId, { id: clientId, socket });

    const parser = attachWsFrameParser(socket, {
      onText(text) {
        if (!connections.has(clientId)) return;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          sendError(socket, 'BAD_JSON', 'Malformed JSON payload');
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        switch (msg.type) {
          case 'join':
            handleJoin(clientId, socket, msg, clientNum);
            break;
          case 'switch_side':
            handleSwitchSide(clientId, socket, msg);
            break;
          case 'set_config':
            handleSetConfig(clientId, socket, msg);
            break;
          case 'start_agent_select':
            handleStartAgentSelect(clientId, socket);
            break;
          case 'select_agent':
            handleSelectAgent(clientId, socket, msg);
            break;
          case 'lock_in':
            handleLockIn(clientId, socket, msg);
            break;
          case 'force_start':
            handleForceStart(clientId, socket);
            break;
          case 'return_to_lobby':
            handleReturnToLobby(clientId, socket);
            break;
          case 'player_state':
          case 'player_damage':
          case 'ability_cast':
          case 'door_event':
          case 'spike_event':
          case 'match_sync':
            handleRelay(clientId, msg);
            break;
          default:
            break;
        }
      },
      onClose() {
        handleDisconnect(clientId);
      },
    });

    socket.on('end', () => {
      handleDisconnect(clientId);
      if (!socket.destroyed) {
        if (socket.writableEnded && !socket.writableFinished) {
          socket.once('finish', () => {
            if (!socket.destroyed) socket.destroy();
          });
        } else {
          socket.destroy();
        }
      }
    });
    socket.on('close', () => handleDisconnect(clientId));
    socket.on('error', () => {
      handleDisconnect(clientId);
      if (!socket.destroyed) socket.destroy();
    });

    if (head && head.length > 0) {
      parser.consume(head);
    }
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const addr = server.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : port;
        if (!silent) {
          console.log(
            `[Chroma Strike MP] WebSocket server listening on ws://127.0.0.1:${boundPort} (max ${MAX_PLAYERS} players, ${MAX_PER_TEAM}/team)`
          );
        }
        resolve({ port: boundPort, host });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const conn of connections.values()) {
        safeWrite(conn.socket, encodeWsFrame(0x8, encodeClosePayload(1001, 'Server shutting down')));
      }
      connections.clear();
      for (const sock of liveSockets) {
        if (!sock.destroyed) sock.destroy();
      }
      liveSockets.clear();
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    room,
    start,
    stop,
    getLobbySnapshot,
  };
}

// Auto-start when executed directly via `node server/gameServer.mjs`
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryFile && path.resolve(currentFile) === entryFile) {
  const instance = createGameServer();
  instance.start().catch((err) => {
    console.error('[Chroma Strike MP] Failed to start server:', err);
    process.exit(1);
  });
}
