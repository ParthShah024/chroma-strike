import {
  AGENT_PALETTES,
  AiDifficulty,
  LobbyPlayerSlot,
  TacticalSide,
} from '../core/types';
import type { LobbyStateSnapshot } from '../net/multiplayer';

export interface LobbyControllerOptions {
  initialDifficulty?: AiDifficulty;
  initialWinTarget?: 10 | 5;
  initialSide?: TacticalSide;
  onJoinSide: (side: TacticalSide) => void;
  onDifficultyChange: (diff: AiDifficulty) => void;
  onWinTargetChange: (winTarget: 10 | 5) => void;
  onCallsignChange?: (callsign: string) => void;
  onRetryConnect: (callsign: string) => void;
  onConnectCustomServer?: (url: string) => void;
  onOpenSettings: () => void;
  onStartMatch: () => void;
  onClose?: () => void;
}

export interface LobbyController {
  open(): void;
  close(): void;
  isOpen(): boolean;
  syncFromNetState(snapshot: LobbyStateSnapshot, localId: string): void;
  showError(msg: string): void;
  getSelectedSide(): TacticalSide;
  getDifficulty(): AiDifficulty;
  getWinTarget(): 10 | 5;
  getCallsign(): string;
  setCallsign(name: string): void;
  setInviteUrl(url: string): void;
  dispose(): void;
}

const CALLSIGN_STORAGE_KEY = 'chroma_strike_callsign_v1';

function loadSavedCallsign(): string {
  try {
    const raw = window.localStorage.getItem(CALLSIGN_STORAGE_KEY);
    if (raw && raw.trim().length > 0) {
      return raw.trim().slice(0, 20);
    }
  } catch {
    // ignore private mode
  }
  return 'AGENT-1';
}

function saveCallsign(name: string): void {
  try {
    window.localStorage.setItem(CALLSIGN_STORAGE_KEY, name);
  } catch {
    // ignore
  }
}

function sanitizeCallsign(raw: string): string {
  const cleaned = raw.trim().replace(/[^\w\s\-().]/g, '').slice(0, 20);
  return cleaned.length > 0 ? cleaned : 'AGENT-1';
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Lobby: missing #${id} in index.html`);
  return el as T;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDefaultInviteUrl(): string {
  if (typeof window === 'undefined' || !window.location) {
    return 'http://127.0.0.1:5174/';
  }
  const loc = window.location;
  if (loc.port === '5173') {
    return `${loc.protocol}//${loc.hostname}:5174${loc.pathname}${loc.search}`;
  }
  return loc.href;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback (e.g. non-HTTPS LAN origins)
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Creates the 6-Player Custom Lobby screen controller (`#lobby-modal`).
 * Displays first on launch (`Lobby -> Agent Select -> Lock In -> Match`),
 * supporting both Live 6-Player Online WebSocket lobbies and Solo Local fallback.
 */
export function createLobbyController(options: LobbyControllerOptions): LobbyController {
  const modal = requireEl<HTMLDivElement>('lobby-modal');
  const statusBadgeEl = requireEl<HTMLDivElement>('lobby-status-badge');
  const retryBtn = requireEl<HTMLButtonElement>('lobby-retry-btn');
  const callsignInput = requireEl<HTMLInputElement>('lobby-callsign-input');
  const settingsBtn = requireEl<HTMLButtonElement>('lobby-settings-btn');
  const errorEl = requireEl<HTMLDivElement>('lobby-error');

  const inviteUrlEl = document.getElementById('lobby-invite-url');
  const copyInviteBtn = document.getElementById('lobby-copy-invite-btn') as HTMLButtonElement | null;
  const serverInput = document.getElementById('lobby-server-input') as HTMLInputElement | null;
  const connectCustomBtn = document.getElementById('lobby-connect-custom-btn') as HTMLButtonElement | null;

  const atkCountEl = requireEl<HTMLSpanElement>('lobby-atk-count');
  const defCountEl = requireEl<HTMLSpanElement>('lobby-def-count');
  const atkSlotsEl = requireEl<HTMLDivElement>('lobby-atk-slots');
  const defSlotsEl = requireEl<HTMLDivElement>('lobby-def-slots');
  const joinAtkBtn = requireEl<HTMLButtonElement>('lobby-join-atk');
  const joinDefBtn = requireEl<HTMLButtonElement>('lobby-join-def');

  const startBtn = requireEl<HTMLButtonElement>('lobby-start-btn');
  const hostNoteEl = document.getElementById('lobby-host-note');

  const diffPills = Array.from(
    modal.querySelectorAll<HTMLButtonElement>('[data-lobby-diff]')
  );
  const winTargetBtns = Array.from(
    modal.querySelectorAll<HTMLButtonElement>('[data-lobby-wintarget]')
  );

  let openState = false;
  let selectedSide: TacticalSide = options.initialSide ?? 'attacker';
  let difficulty: AiDifficulty = options.initialDifficulty ?? 'casual';
  let winTarget: 10 | 5 = options.initialWinTarget === 5 ? 5 : 10;
  let callsign = loadSavedCallsign();
  let inviteUrl = getDefaultInviteUrl();
  let lastOnline = false;
  let lastIsHost = true;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  const defaultCopyBtnLabel = copyInviteBtn?.textContent?.trim() || 'COPY INVITE';

  callsignInput.value = callsign;

  function renderInviteUrl(): void {
    if (!inviteUrlEl) return;
    if (inviteUrlEl instanceof HTMLInputElement || inviteUrlEl instanceof HTMLTextAreaElement) {
      inviteUrlEl.value = inviteUrl;
    } else {
      inviteUrlEl.textContent = inviteUrl;
    }
  }

  function setInviteUrl(url: string): void {
    const trimmed = url.trim();
    inviteUrl = trimmed.length > 0 ? trimmed : getDefaultInviteUrl();
    renderInviteUrl();
  }

  function setCallsign(name: string): void {
    const next = sanitizeCallsign(name);
    callsign = next;
    callsignInput.value = next;
    saveCallsign(next);
  }

  renderInviteUrl();

  function clearErrorTimer(): void {
    if (errorTimer !== null) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  function showError(msg: string): void {
    clearErrorTimer();
    const trimmed = msg.trim();
    if (!trimmed) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
      return;
    }
    errorEl.textContent = trimmed;
    errorEl.classList.remove('hidden');
    errorTimer = setTimeout(() => {
      errorEl.classList.add('hidden');
      errorEl.textContent = '';
      errorTimer = null;
    }, 5500);
  }

  function renderTeamSlots(
    container: HTMLDivElement,
    sidePlayers: LobbyPlayerSlot[],
    localId: string,
    side: TacticalSide
  ): void {
    const bySlot = new Map<number, LobbyPlayerSlot>();
    for (const p of sidePlayers) {
      bySlot.set(p.slotIndex, p);
    }

    container.replaceChildren();
    for (let slotIdx = 0; slotIdx < 3; slotIdx++) {
      const player = bySlot.get(slotIdx);
      const row = document.createElement('div');
      row.className = 'lobby-slot';

      if (player) {
        const isYou = player.id === localId;
        const palette = AGENT_PALETTES[player.agentColor];
        row.classList.add('occupied');
        if (isYou) row.classList.add('is-you');
        row.style.setProperty('--slot-accent', palette.css);

        const tags: string[] = [];
        if (isYou) tags.push('<span class="lobby-tag you">YOU</span>');
        if (player.isHost) tags.push('<span class="lobby-tag host">HOST</span>');

        row.innerHTML = `
          <span class="lobby-slot-num">${slotIdx + 1}</span>
          <span class="lobby-slot-dot"></span>
          <span class="lobby-slot-name">${escapeHtml(player.name)}</span>
          <span class="lobby-slot-tags">${tags.join('')}</span>
        `;
      } else {
        row.classList.add('bot-fill');
        row.innerHTML = `
          <span class="lobby-slot-num">${slotIdx + 1}</span>
          <span class="lobby-slot-dot bot"></span>
          <span class="lobby-slot-name">BOT AUTO-FILL</span>
          <span class="lobby-slot-tags"><span class="lobby-tag bot">${side === 'attacker' ? 'ATK AI' : 'DEF AI'}</span></span>
        `;
      }

      container.appendChild(row);
    }
  }

  function syncControlsState(): void {
    const controlsLocked = lastOnline && !lastIsHost;

    for (const pill of diffPills) {
      const d = pill.dataset.lobbyDiff as AiDifficulty;
      const active = d === difficulty;
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
      pill.disabled = controlsLocked;
    }

    for (const btn of winTargetBtns) {
      const wt = Number(btn.dataset.lobbyWintarget);
      const active = wt === winTarget;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.disabled = controlsLocked;
    }

    startBtn.disabled = controlsLocked;
    startBtn.textContent = controlsLocked
      ? 'WAITING FOR HOST TO START...'
      : 'START MATCH -> AGENT SELECT';
    if (hostNoteEl) {
      hostNoteEl.textContent = lastOnline
        ? lastIsHost
          ? 'You are Host — configure match & launch Agent Select'
          : 'Connected to host lobby — pick Attackers or Defenders'
        : 'Solo Local Mode — Bots automatically fill remaining 5 slots';
    }
  }

  function syncFromNetState(snapshot: LobbyStateSnapshot, localId: string): void {
    lastOnline = snapshot.online;
    const localPlayer = snapshot.players.find((p) => p.id === localId);
    lastIsHost = !snapshot.online || snapshot.hostId === localId || Boolean(localPlayer?.isHost);

    if (localPlayer) {
      selectedSide = localPlayer.side;
    }
    difficulty = snapshot.difficulty;
    winTarget = snapshot.winTarget === 5 ? 5 : 10;

    // Header connection badge
    statusBadgeEl.classList.toggle('online', snapshot.online);
    statusBadgeEl.classList.toggle('offline', !snapshot.online);
    statusBadgeEl.textContent = snapshot.online
      ? `ONLINE • ${snapshot.players.length} / ${snapshot.maxPlayers} PLAYERS`
      : `SOLO LOCAL • 1 / ${snapshot.maxPlayers} (BOTS FILL)`;

    retryBtn.classList.toggle('hidden', snapshot.online);

    const atkPlayers = snapshot.players
      .filter((p) => p.side === 'attacker')
      .sort((a, b) => a.slotIndex - b.slotIndex);
    const defPlayers = snapshot.players
      .filter((p) => p.side === 'defender')
      .sort((a, b) => a.slotIndex - b.slotIndex);

    atkCountEl.textContent = `${atkPlayers.length} / ${snapshot.maxPerTeam} HUMANS`;
    defCountEl.textContent = `${defPlayers.length} / ${snapshot.maxPerTeam} HUMANS`;

    renderTeamSlots(atkSlotsEl, atkPlayers, localId, 'attacker');
    renderTeamSlots(defSlotsEl, defPlayers, localId, 'defender');

    joinAtkBtn.disabled =
      selectedSide === 'attacker' || atkPlayers.length >= snapshot.maxPerTeam;
    joinAtkBtn.textContent =
      selectedSide === 'attacker'
        ? 'JOINED ATTACKERS'
        : atkPlayers.length >= snapshot.maxPerTeam
          ? 'ATTACKERS FULL (3/3)'
          : 'JOIN ATTACKERS';

    joinDefBtn.disabled =
      selectedSide === 'defender' || defPlayers.length >= snapshot.maxPerTeam;
    joinDefBtn.textContent =
      selectedSide === 'defender'
        ? 'JOINED DEFENDERS'
        : defPlayers.length >= snapshot.maxPerTeam
          ? 'DEFENDERS FULL (3/3)'
          : 'JOIN DEFENDERS';

    syncControlsState();
  }

  function commitCallsign(notify: boolean): void {
    const next = sanitizeCallsign(callsignInput.value);
    const changed = next !== callsign;
    callsign = next;
    callsignInput.value = next;
    saveCallsign(next);
    if (notify && changed) {
      options.onCallsignChange?.(next);
    }
  }

  function onJoinAtk(): void {
    showError('');
    options.onJoinSide('attacker');
  }

  function onJoinDef(): void {
    showError('');
    options.onJoinSide('defender');
  }

  function onRetry(): void {
    commitCallsign(false);
    showError('');
    options.onRetryConnect(callsign);
  }

  function onSettingsClick(): void {
    options.onOpenSettings();
  }

  function onStartClick(): void {
    if (lastOnline && !lastIsHost) return;
    commitCallsign(false);
    showError('');
    options.onStartMatch();
  }

  function onCallsignKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Enter') {
      e.preventDefault();
      commitCallsign(true);
      callsignInput.blur();
    }
    e.stopPropagation();
  }

  function onCallsignBlur(): void {
    commitCallsign(true);
  }

  function onCopyInviteClick(): void {
    const currentUrl =
      inviteUrlEl instanceof HTMLInputElement || inviteUrlEl instanceof HTMLTextAreaElement
        ? inviteUrlEl.value.trim() || inviteUrl
        : inviteUrl;
    void copyTextToClipboard(currentUrl).then((ok) => {
      if (!copyInviteBtn) return;
      if (copyTimer !== null) {
        clearTimeout(copyTimer);
        copyTimer = null;
      }
      copyInviteBtn.textContent = ok ? 'COPIED!' : 'COPY FAILED';
      copyInviteBtn.classList.toggle('copied', ok);
      copyTimer = setTimeout(() => {
        copyInviteBtn.textContent = defaultCopyBtnLabel;
        copyInviteBtn.classList.remove('copied');
        copyTimer = null;
      }, 1800);
    });
  }

  function onConnectCustomClick(): void {
    commitCallsign(false);
    showError('');
    const customUrl = serverInput?.value.trim() ?? '';
    if (customUrl.length > 0 && options.onConnectCustomServer) {
      options.onConnectCustomServer(customUrl);
    } else if (options.onConnectCustomServer) {
      options.onConnectCustomServer(customUrl);
    } else {
      options.onRetryConnect(callsign);
    }
  }

  function onServerInputKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Enter') {
      e.preventDefault();
      onConnectCustomClick();
      serverInput?.blur();
    }
    e.stopPropagation();
  }

  joinAtkBtn.addEventListener('click', onJoinAtk);
  joinDefBtn.addEventListener('click', onJoinDef);
  retryBtn.addEventListener('click', onRetry);
  settingsBtn.addEventListener('click', onSettingsClick);
  startBtn.addEventListener('click', onStartClick);
  callsignInput.addEventListener('keydown', onCallsignKeyDown);
  callsignInput.addEventListener('blur', onCallsignBlur);
  copyInviteBtn?.addEventListener('click', onCopyInviteClick);
  connectCustomBtn?.addEventListener('click', onConnectCustomClick);
  serverInput?.addEventListener('keydown', onServerInputKeyDown);

  for (const pill of diffPills) {
    pill.addEventListener('click', () => {
      if (lastOnline && !lastIsHost) return;
      const diff = (pill.dataset.lobbyDiff as AiDifficulty) ?? 'casual';
      difficulty = diff;
      syncControlsState();
      options.onDifficultyChange(diff);
    });
  }

  for (const btn of winTargetBtns) {
    btn.addEventListener('click', () => {
      if (lastOnline && !lastIsHost) return;
      const wt = Number(btn.dataset.lobbyWintarget) === 5 ? 5 : 10;
      winTarget = wt;
      syncControlsState();
      options.onWinTargetChange(wt);
    });
  }

  function open(): void {
    const latest = loadSavedCallsign();
    if (latest !== callsign) {
      callsign = latest;
      callsignInput.value = latest;
    }
    openState = true;
    modal.classList.remove('hidden');
    renderInviteUrl();
    syncControlsState();
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    modal.classList.add('hidden');
    options.onClose?.();
  }

  function dispose(): void {
    clearErrorTimer();
    if (copyTimer !== null) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
    joinAtkBtn.removeEventListener('click', onJoinAtk);
    joinDefBtn.removeEventListener('click', onJoinDef);
    retryBtn.removeEventListener('click', onRetry);
    settingsBtn.removeEventListener('click', onSettingsClick);
    startBtn.removeEventListener('click', onStartClick);
    callsignInput.removeEventListener('keydown', onCallsignKeyDown);
    callsignInput.removeEventListener('blur', onCallsignBlur);
    copyInviteBtn?.removeEventListener('click', onCopyInviteClick);
    connectCustomBtn?.removeEventListener('click', onConnectCustomClick);
    serverInput?.removeEventListener('keydown', onServerInputKeyDown);
  }

  modal.classList.add('hidden');
  syncControlsState();

  return {
    open,
    close,
    isOpen: () => openState,
    syncFromNetState,
    showError,
    getSelectedSide: () => selectedSide,
    getDifficulty: () => difficulty,
    getWinTarget: () => winTarget,
    getCallsign: () => callsign,
    setCallsign,
    setInviteUrl,
    dispose,
  };
}
