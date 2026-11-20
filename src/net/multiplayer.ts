import {
  AGENT_ORDER,
  AgentColorId,
  AiDifficulty,
  LobbyPhase,
  LobbyPlayerSlot,
  RemotePlayerNetState,
  TacticalSide,
  Vec3,
  WeaponId,
} from '../core/types';

export type { LobbyPhase, LobbyPlayerSlot, RemotePlayerNetState };

export interface LobbyStateSnapshot {
  phase: LobbyPhase;
  hostId: string | null;
  difficulty: AiDifficulty;
  winTarget: 10 | 5;
  swapInterval: number;
  autoFillBots: boolean;
  maxPlayers: number;
  maxPerTeam: number;
  online: boolean;
  players: LobbyPlayerSlot[];
}

export interface LobbyConfigPatch {
  difficulty?: AiDifficulty;
  winTarget?: 10 | 5;
  autoFillBots?: boolean;
}

export interface DoorNetEvent {
  doorId: string;
  action: 'toggle' | 'damage' | 'break';
  state?: 'open' | 'closed' | 'broken';
  damage?: number;
  fromId?: string;
}

export interface DamageNetEvent {
  targetPlayerId?: string;
  targetSlotId?: string;
  damage: number;
  headshot: boolean;
  weaponTag: string;
  fromId?: string;
}

export interface MatchSyncPayload {
  roundNumber: number;
  phase: string;
  allyScore: number;
  enemyScore: number;
  phaseTimerSec: number;
  fromId?: string;
}

export interface PlayerStateOutbound {
  side?: TacticalSide;
  slotIndex?: 0 | 1 | 2;
  agentColor: AgentColorId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  alive: boolean;
  weaponId: WeaponId;
  firing?: boolean;
  sliding?: boolean;
  crouching?: boolean;
  ultActive?: boolean;
}

export interface MultiplayerError {
  code: string;
  message: string;
}

export interface SurrenderNetPayload {
  side: TacticalSide;
  byName: string;
}

export interface MultiplayerClient {
  connect(playerName?: string, customServerUrl?: string): void;
  reconnect(): void;
  disconnect(): void;
  getServerUrl(): string;
  getLobbyState(): LobbyStateSnapshot;
  getLocalPlayerId(): string;
  getRemotePlayers(): RemotePlayerNetState[];
  isOnline(): boolean;
  isHost(): boolean;
  setPlayerName(name: string): void;
  switchSide(side: TacticalSide): void;
  setConfig(cfg: LobbyConfigPatch): void;
  startAgentSelect(): void;
  selectAgent(color: AgentColorId): void;
  lockIn(color?: AgentColorId): void;
  forceStartMatch(): void;
  returnToLobby(): void;
  sendSurrender(): void;
  sendPlayerState(state: PlayerStateOutbound): void;
  sendDoorEvent(event: DoorNetEvent): void;
  sendDamage(event: DamageNetEvent): void;
  sendMatchSync(payload: MatchSyncPayload): void;
  onLobbyUpdate(cb: (state: LobbyStateSnapshot) => void): () => void;
  onMatchStart(cb: (state: LobbyStateSnapshot) => void): () => void;
  onRemoteState(cb: (state: RemotePlayerNetState) => void): () => void;
  onDoorEvent(cb: (event: DoorNetEvent) => void): () => void;
  onDamage(cb: (event: DamageNetEvent) => void): () => void;
  onMatchSync(cb: (payload: MatchSyncPayload) => void): () => void;
  onSurrender(cb: (payload: SurrenderNetPayload) => void): () => void;
  onError(cb: (err: MultiplayerError) => void): () => void;
}

const LOCAL_OFFLINE_ID = 'local-host';
const CONNECT_TIMEOUT_MS = 2500;
const STATE_SEND_MIN_INTERVAL_MS = 33; // ~30Hz position sync cap
const REMOTE_STALE_MS = 5000;

function isPageHttps(): boolean {
  return typeof window !== 'undefined' && window.location?.protocol === 'https:';
}

function normalizeServerUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return resolveDefaultServerUrl();

  let url = trimmed;
  if (/^https:\/\//i.test(url)) {
    url = 'wss://' + url.slice(8);
  } else if (/^http:\/\//i.test(url)) {
    url = 'ws://' + url.slice(7);
  } else if (!/^wss?:\/\//i.test(url)) {
    url = `${isPageHttps() ? 'wss' : 'ws'}://${url}`;
  }

  // Upgrade ws:// -> wss:// automatically when the page itself is served over HTTPS
  if (isPageHttps() && /^ws:\/\//i.test(url)) {
    url = 'wss://' + url.slice(5);
  }

  return url;
}

function resolveQueryServerUrl(): string | null {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const param = params.get('server');
    if (param && param.trim().length > 0) {
      return normalizeServerUrl(param);
    }
  } catch {
    // ignore malformed query strings
  }
  return null;
}

function resolveDefaultServerUrl(): string {
  const queryUrl = resolveQueryServerUrl();
  if (queryUrl) return queryUrl;

  if (typeof window === 'undefined' || !window.location) {
    return 'ws://127.0.0.1:5174';
  }

  const proto = isPageHttps() ? 'wss' : 'ws';
  const hostname = window.location.hostname || '127.0.0.1';
  const port = window.location.port;

  // Vite dev server (5173) -> connect to local/LAN game server on 5174
  if (port === '5173') {
    return `${proto}://${hostname}:5174`;
  }

  // Single-port game server (5174) or HTTPS tunnel / reverse proxy -> same host & port
  if (port === '5174' || window.location.host) {
    return `${proto}://${window.location.host}`;
  }

  return `${proto}://${hostname}:5174`;
}

function sanitizeLocalName(rawName: string): string {
  const cleaned = rawName.trim().replace(/[^\w\s\-().]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : 'AGENT-1';
}

function finiteNum(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cloneLobbyState(state: LobbyStateSnapshot): LobbyStateSnapshot {
  return {
    ...state,
    players: state.players.map((p) => ({ ...p })),
  };
}

/**
 * Creates the Chroma Strike 6-Player WebSocket client with automatic 2.5s
 * offline fallback into a 1/6 Solo Local Lobby so singleplayer flows seamlessly
 * through Lobby -> Agent Select -> Match even when the WS server is not running.
 */
export function createMultiplayerClient(serverUrl?: string): MultiplayerClient {
  let wsUrl = serverUrl ? normalizeServerUrl(serverUrl) : resolveDefaultServerUrl();

  let socket: WebSocket | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let online = false;
  let localPlayerId = LOCAL_OFFLINE_ID;
  let localPlayerName = 'AGENT-1';
  let lastStateSendMs = 0;
  let lastSentAlive = true;

  let lobbyState: LobbyStateSnapshot = {
    phase: 'lobby',
    hostId: LOCAL_OFFLINE_ID,
    difficulty: 'casual',
    winTarget: 10,
    swapInterval: 5,
    autoFillBots: true,
    maxPlayers: 6,
    maxPerTeam: 3,
    online: false,
    players: [
      {
        id: LOCAL_OFFLINE_ID,
        name: localPlayerName,
        side: 'attacker',
        slotIndex: 0,
        agentColor: 'red',
        lockedIn: false,
        isHost: true,
      },
    ],
  };

  const remotePlayers = new Map<string, RemotePlayerNetState>();

  const lobbyListeners = new Set<(state: LobbyStateSnapshot) => void>();
  const matchStartListeners = new Set<(state: LobbyStateSnapshot) => void>();
  const remoteStateListeners = new Set<(state: RemotePlayerNetState) => void>();
  const doorListeners = new Set<(event: DoorNetEvent) => void>();
  const damageListeners = new Set<(event: DamageNetEvent) => void>();
  const matchSyncListeners = new Set<(payload: MatchSyncPayload) => void>();
  const surrenderListeners = new Set<(payload: SurrenderNetPayload) => void>();
  const errorListeners = new Set<(err: MultiplayerError) => void>();

  function emitLobbyUpdate(): void {
    const snap = cloneLobbyState(lobbyState);
    for (const cb of lobbyListeners) {
      try {
        cb(snap);
      } catch {
        // isolate UI listener failures
      }
    }
  }

  function emitMatchStart(): void {
    const snap = cloneLobbyState(lobbyState);
    for (const cb of matchStartListeners) {
      try {
        cb(snap);
      } catch {
        // isolate UI listener failures
      }
    }
  }

  function emitError(code: string, message: string): void {
    for (const cb of errorListeners) {
      try {
        cb({ code, message });
      } catch {
        // isolate listener failures
      }
    }
  }

  function clearConnectTimer(): void {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function closeSocketQuietly(): void {
    clearConnectTimer();
    if (socket) {
      const s = socket;
      socket = null;
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.close(1000, 'Client disconnect');
        }
      } catch {
        // ignore
      }
    }
  }

  function activateOfflineSoloLobby(preserveCurrentConfig = true): void {
    online = false;
    localPlayerId = LOCAL_OFFLINE_ID;
    remotePlayers.clear();

    const prevLocal = lobbyState.players.find((p) => p.id === localPlayerId) ?? lobbyState.players[0];
    const side: TacticalSide = prevLocal?.side ?? 'attacker';
    const agentColor: AgentColorId = prevLocal?.agentColor ?? 'red';

    lobbyState = {
      phase: preserveCurrentConfig ? lobbyState.phase : 'lobby',
      hostId: LOCAL_OFFLINE_ID,
      difficulty: preserveCurrentConfig ? lobbyState.difficulty : 'casual',
      winTarget: preserveCurrentConfig ? lobbyState.winTarget : 10,
      swapInterval: 5,
      autoFillBots: true,
      maxPlayers: 6,
      maxPerTeam: 3,
      online: false,
      players: [
        {
          id: LOCAL_OFFLINE_ID,
          name: localPlayerName,
          side,
          slotIndex: 0,
          agentColor,
          lockedIn: preserveCurrentConfig && lobbyState.phase === 'playing',
          isHost: true,
        },
      ],
    };
    emitLobbyUpdate();
  }

  function sendWs(payload: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function applyServerLobbySnapshot(raw: Partial<LobbyStateSnapshot>): void {
    lobbyState = {
      phase: raw.phase ?? 'lobby',
      hostId: raw.hostId ?? null,
      difficulty: raw.difficulty ?? 'casual',
      winTarget: raw.winTarget === 5 ? 5 : 10,
      swapInterval: raw.swapInterval ?? 5,
      autoFillBots: raw.autoFillBots !== false,
      maxPlayers: raw.maxPlayers ?? 6,
      maxPerTeam: raw.maxPerTeam ?? 3,
      online: true,
      players: Array.isArray(raw.players) ? raw.players.map((p) => ({ ...p })) : [],
    };
  }

  function connect(playerName?: string, customServerUrl?: string): void {
    if (typeof customServerUrl === 'string' && customServerUrl.trim().length > 0) {
      wsUrl = normalizeServerUrl(customServerUrl);
    }

    if (playerName && playerName.trim().length > 0) {
      localPlayerName = sanitizeLocalName(playerName);
      if (!online && lobbyState.players[0]) {
        lobbyState.players[0].name = localPlayerName;
      }
    }

    closeSocketQuietly();

    if (typeof WebSocket === 'undefined') {
      activateOfflineSoloLobby(true);
      return;
    }

    let settled = false;
    let rejectedServerFull = false;

    const fallbackToOffline = (): void => {
      if (settled) return;
      settled = true;
      closeSocketQuietly();
      activateOfflineSoloLobby(true);
    };

    connectTimer = setTimeout(fallbackToOffline, CONNECT_TIMEOUT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      fallbackToOffline();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      clearConnectTimer();
      const preferredSide = lobbyState.players[0]?.side ?? 'attacker';
      sendWs({
        type: 'join',
        name: localPlayerName,
        preferredSide,
      });
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (socket !== ws) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'welcome': {
          settled = true;
          online = true;
          if (typeof msg.playerId === 'string') {
            localPlayerId = msg.playerId;
          }
          if (msg.state && typeof msg.state === 'object') {
            applyServerLobbySnapshot(msg.state as Partial<LobbyStateSnapshot>);
          }
          emitLobbyUpdate();
          break;
        }
        case 'lobby_state': {
          if (msg.state && typeof msg.state === 'object') {
            settled = true;
            online = true;
            applyServerLobbySnapshot(msg.state as Partial<LobbyStateSnapshot>);
            emitLobbyUpdate();
          }
          break;
        }
        case 'match_start': {
          if (msg.state && typeof msg.state === 'object') {
            applyServerLobbySnapshot(msg.state as Partial<LobbyStateSnapshot>);
          } else {
            lobbyState.phase = 'playing';
          }
          emitLobbyUpdate();
          emitMatchStart();
          break;
        }
        case 'player_left': {
          if (typeof msg.playerId === 'string') {
            remotePlayers.delete(msg.playerId);
          }
          if (msg.state && typeof msg.state === 'object') {
            applyServerLobbySnapshot(msg.state as Partial<LobbyStateSnapshot>);
            emitLobbyUpdate();
          }
          break;
        }
        case 'remote_state': {
          const pid = String(msg.playerId ?? '');
          if (!pid || pid === localPlayerId) break;
          const pos = (msg.position as Partial<Vec3>) ?? {};
          const vel = (msg.velocity as Partial<Vec3>) ?? {};
          const remote: RemotePlayerNetState = {
            playerId: pid,
            name: String(msg.name ?? 'AGENT'),
            side: msg.side === 'defender' ? 'defender' : 'attacker',
            slotIndex: (msg.slotIndex === 1 || msg.slotIndex === 2 ? msg.slotIndex : 0) as 0 | 1 | 2,
            agentColor: AGENT_ORDER.includes(msg.agentColor as AgentColorId)
              ? (msg.agentColor as AgentColorId)
              : 'red',
            position: {
              x: finiteNum(pos.x, 0),
              y: finiteNum(pos.y, 0),
              z: finiteNum(pos.z, 0),
            },
            velocity: {
              x: finiteNum(vel.x, 0),
              y: finiteNum(vel.y, 0),
              z: finiteNum(vel.z, 0),
            },
            yaw: finiteNum(msg.yaw, 0),
            pitch: finiteNum(msg.pitch, 0),
            health: finiteNum(msg.health, 100),
            armor: finiteNum(msg.armor, 0),
            alive: msg.alive !== false,
            weaponId: (msg.weaponId as WeaponId) ?? 'pistol',
            firing: Boolean(msg.firing),
            sliding: Boolean(msg.sliding),
            crouching: Boolean(msg.crouching),
            ultActive: Boolean(msg.ultActive),
            timestampMs: Date.now(),
          };
          remotePlayers.set(pid, remote);
          for (const cb of remoteStateListeners) {
            try {
              cb(remote);
            } catch {
              // ignore
            }
          }
          break;
        }
        case 'door_event': {
          const doorEv: DoorNetEvent = {
            doorId: String(msg.doorId ?? ''),
            action: (msg.action as DoorNetEvent['action']) ?? 'toggle',
            state: msg.state as DoorNetEvent['state'],
            damage: typeof msg.damage === 'number' ? msg.damage : undefined,
            fromId: typeof msg.fromId === 'string' ? msg.fromId : undefined,
          };
          for (const cb of doorListeners) {
            try {
              cb(doorEv);
            } catch {
              // ignore
            }
          }
          break;
        }
        case 'player_damage': {
          const dmgEv: DamageNetEvent = {
            targetPlayerId:
              typeof msg.targetPlayerId === 'string' ? msg.targetPlayerId : undefined,
            targetSlotId: typeof msg.targetSlotId === 'string' ? msg.targetSlotId : undefined,
            damage: finiteNum(msg.damage, 0),
            headshot: Boolean(msg.headshot),
            weaponTag: String(msg.weaponTag ?? 'AR'),
            fromId: typeof msg.fromId === 'string' ? msg.fromId : undefined,
          };
          for (const cb of damageListeners) {
            try {
              cb(dmgEv);
            } catch {
              // ignore
            }
          }
          break;
        }
        case 'match_sync': {
          const syncPayload: MatchSyncPayload = {
            roundNumber: finiteNum(msg.roundNumber, 1),
            phase: String(msg.phase ?? 'buy'),
            allyScore: finiteNum(msg.allyScore, 0),
            enemyScore: finiteNum(msg.enemyScore, 0),
            phaseTimerSec: finiteNum(msg.phaseTimerSec, 0),
            fromId: typeof msg.fromId === 'string' ? msg.fromId : undefined,
          };
          for (const cb of matchSyncListeners) {
            try {
              cb(syncPayload);
            } catch {
              // ignore
            }
          }
          break;
        }
        case 'surrender': {
          const payload: SurrenderNetPayload = {
            side: msg.side === 'defender' ? 'defender' : 'attacker',
            byName: String(msg.byName ?? 'AGENT'),
          };
          for (const cb of surrenderListeners) {
            try {
              cb(payload);
            } catch {
              // ignore
            }
          }
          break;
        }
        case 'error': {
          const code = String(msg.code ?? 'ERROR');
          const message = String(msg.message ?? 'Multiplayer error');
          if (code === 'SERVER_FULL') {
            rejectedServerFull = true;
          }
          emitError(code, message);
          break;
        }
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (socket !== ws) return;
      if (!online) {
        fallbackToOffline();
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      if (socket !== ws) return;
      clearConnectTimer();
      socket = null;

      if (ev.code === 4000 && !rejectedServerFull) {
        emitError('SERVER_FULL', ev.reason || 'Server full (6/6 players max)');
      } else if (online && !rejectedServerFull) {
        emitError('DISCONNECTED', 'Disconnected from multiplayer server — switched to Solo Local Lobby');
      }

      settled = true;
      activateOfflineSoloLobby(true);
    };
  }

  function reconnect(): void {
    connect(localPlayerName);
  }

  function disconnect(): void {
    closeSocketQuietly();
    activateOfflineSoloLobby(true);
  }

  function getServerUrl(): string {
    return wsUrl;
  }

  function getLobbyState(): LobbyStateSnapshot {
    return cloneLobbyState(lobbyState);
  }

  function getLocalPlayerId(): string {
    return localPlayerId;
  }

  function getRemotePlayers(): RemotePlayerNetState[] {
    const now = Date.now();
    const active: RemotePlayerNetState[] = [];
    for (const [id, st] of remotePlayers.entries()) {
      if (now - st.timestampMs > REMOTE_STALE_MS) {
        remotePlayers.delete(id);
      } else {
        active.push({ ...st });
      }
    }
    return active;
  }

  function isOnline(): boolean {
    return online;
  }

  function isHost(): boolean {
    return !online || lobbyState.hostId === localPlayerId;
  }

  function setPlayerName(name: string): void {
    localPlayerName = sanitizeLocalName(name);
    if (online) {
      sendWs({ type: 'set_name', name: localPlayerName });
      return;
    }
    const local = lobbyState.players.find((p) => p.id === localPlayerId) ?? lobbyState.players[0];
    if (local) {
      local.name = localPlayerName;
      emitLobbyUpdate();
    }
  }

  function switchSide(side: TacticalSide): void {
    if (online) {
      sendWs({ type: 'switch_side', side });
      return;
    }
    if (lobbyState.phase !== 'lobby') return;
    const local = lobbyState.players[0];
    if (local) {
      local.side = side;
      local.slotIndex = 0;
      emitLobbyUpdate();
    }
  }

  function setConfig(cfg: LobbyConfigPatch): void {
    if (online) {
      sendWs({ type: 'set_config', ...cfg });
      return;
    }
    if (cfg.difficulty) lobbyState.difficulty = cfg.difficulty;
    if (cfg.winTarget === 10 || cfg.winTarget === 5) lobbyState.winTarget = cfg.winTarget;
    if (typeof cfg.autoFillBots === 'boolean') lobbyState.autoFillBots = cfg.autoFillBots;
    emitLobbyUpdate();
  }

  function startAgentSelect(): void {
    if (online) {
      sendWs({ type: 'start_agent_select' });
      return;
    }
    lobbyState.phase = 'agent_select';
    for (const p of lobbyState.players) {
      p.lockedIn = false;
    }
    emitLobbyUpdate();
  }

  function selectAgent(color: AgentColorId): void {
    if (online) {
      sendWs({ type: 'select_agent', agentColor: color });
      return;
    }
    const local = lobbyState.players[0];
    if (local) {
      local.agentColor = color;
      local.lockedIn = false;
      emitLobbyUpdate();
    }
  }

  function lockIn(color?: AgentColorId): void {
    if (online) {
      sendWs({ type: 'lock_in', agentColor: color });
      return;
    }
    const local = lobbyState.players[0];
    if (local) {
      if (color) local.agentColor = color;
      local.lockedIn = true;
    }
    lobbyState.phase = 'playing';
    emitLobbyUpdate();
    emitMatchStart();
  }

  function forceStartMatch(): void {
    if (online) {
      sendWs({ type: 'force_start' });
      return;
    }
    for (const p of lobbyState.players) {
      p.lockedIn = true;
    }
    lobbyState.phase = 'playing';
    emitLobbyUpdate();
    emitMatchStart();
  }

  function returnToLobby(): void {
    if (online) {
      sendWs({ type: 'return_to_lobby' });
      return;
    }
    lobbyState.phase = 'lobby';
    for (const p of lobbyState.players) {
      p.lockedIn = false;
    }
    emitLobbyUpdate();
  }

  function sendSurrender(): void {
    const local = lobbyState.players.find((p) => p.id === localPlayerId) ?? lobbyState.players[0];
    const side: TacticalSide = local?.side ?? 'attacker';
    if (online) {
      sendWs({ type: 'surrender', side });
      return;
    }
    const payload: SurrenderNetPayload = { side, byName: localPlayerName };
    for (const cb of surrenderListeners) {
      try {
        cb(payload);
      } catch {
        // ignore
      }
    }
  }

  function sendPlayerState(state: PlayerStateOutbound): void {
    if (!online || lobbyState.phase !== 'playing') return;
    const now = Date.now();
    const importantEvent = Boolean(state.firing) || state.alive !== lastSentAlive;
    if (!importantEvent && now - lastStateSendMs < STATE_SEND_MIN_INTERVAL_MS) {
      return;
    }
    lastStateSendMs = now;
    lastSentAlive = state.alive;
    sendWs({
      type: 'player_state',
      ...state,
    });
  }

  function sendDoorEvent(event: DoorNetEvent): void {
    if (!online || lobbyState.phase !== 'playing') return;
    sendWs({
      type: 'door_event',
      ...event,
    });
  }

  function sendDamage(event: DamageNetEvent): void {
    if (!online || lobbyState.phase !== 'playing') return;
    sendWs({
      type: 'player_damage',
      ...event,
    });
  }

  function sendMatchSync(payload: MatchSyncPayload): void {
    if (!online || lobbyState.phase !== 'playing') return;
    sendWs({
      type: 'match_sync',
      ...payload,
    });
  }

  function onLobbyUpdate(cb: (state: LobbyStateSnapshot) => void): () => void {
    lobbyListeners.add(cb);
    return () => lobbyListeners.delete(cb);
  }

  function onMatchStart(cb: (state: LobbyStateSnapshot) => void): () => void {
    matchStartListeners.add(cb);
    return () => matchStartListeners.delete(cb);
  }

  function onRemoteState(cb: (state: RemotePlayerNetState) => void): () => void {
    remoteStateListeners.add(cb);
    return () => remoteStateListeners.delete(cb);
  }

  function onDoorEvent(cb: (event: DoorNetEvent) => void): () => void {
    doorListeners.add(cb);
    return () => doorListeners.delete(cb);
  }

  function onDamage(cb: (event: DamageNetEvent) => void): () => void {
    damageListeners.add(cb);
    return () => damageListeners.delete(cb);
  }

  function onMatchSync(cb: (payload: MatchSyncPayload) => void): () => void {
    matchSyncListeners.add(cb);
    return () => matchSyncListeners.delete(cb);
  }

  function onSurrender(cb: (payload: SurrenderNetPayload) => void): () => void {
    surrenderListeners.add(cb);
    return () => surrenderListeners.delete(cb);
  }

  function onError(cb: (err: MultiplayerError) => void): () => void {
    errorListeners.add(cb);
    return () => errorListeners.delete(cb);
  }

  return {
    connect,
    reconnect,
    disconnect,
    getServerUrl,
    getLobbyState,
    getLocalPlayerId,
    getRemotePlayers,
    isOnline,
    isHost,
    setPlayerName,
    switchSide,
    setConfig,
    startAgentSelect,
    selectAgent,
    lockIn,
    forceStartMatch,
    returnToLobby,
    sendSurrender,
    sendPlayerState,
    sendDoorEvent,
    sendDamage,
    sendMatchSync,
    onLobbyUpdate,
    onMatchStart,
    onRemoteState,
    onDoorEvent,
    onDamage,
    onMatchSync,
    onSurrender,
    onError,
  };
}
