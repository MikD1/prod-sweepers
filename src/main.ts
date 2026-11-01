import './style.css';
import {
  buyUpgrade, createGame, equipTool, getCapacity, getContextAction, getBuildRequirement, getBuildPlacementError, getBuildingConnections, getBuildingStatus,
  getNearbyStation, getNearestTerminal, getReceiverCapacity, getRobotStatus, getUpgradeRequirement, getVehicle, getWalkingCapacity, reclaimBugs, sellRecovered,
  interact, placeBuilding, removeBuilding, rotateBuilding, toggleVehicle, updateGame, upgradePrice,
} from './game/engine';
import { drawLotti, hitTestBuilding, renderMinimap, renderWorld } from './game/renderer';
import { loadFromStorage, saveToStorage } from './game/persistence';
import { BackgroundMusic } from './game/music';
import { generateDevelopedGame } from './game/generation';
import type { DevelopedProgress } from './game/starts';
import { FIRST_LINE_COST, productionGuide } from './game/production-guide';
import { drawOverviewMap, overviewContent, updateOverview } from './game/overview';
import {
  BUILD_CELL, BUILDINGS, ECONOMY, MATERIALS, PROCESSING, RECEIVER_CAPACITY, ROBOTS, STATIONS, STRUCTURES, TOOLS, VEHICLES, WORLD_H, WORLD_W,
  type ActionResult, type BuildKind, type Direction, type GameState, type MaterialKind, type RobotKind, type StationKind, type ToolId, type UpgradeId, type VehicleKind, type Vec,
} from './game/types';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const icon = (name: string, size = 20) => {
  const paths: Record<string, string> = {
    brush: '<path d="m5 19 9-9m-1-4 5-3 3 3-3 5-5-5ZM3 17l4 4m-5-1 2 2"/>',
    coin: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 5-4 2v6l4 2 4-2V9l-4-2Z"/>',
    bag: '<path d="M5 8h14v13H5V8Zm4 0V4h6v4M5 14h14m-9 0v3h4v-3"/>',
    gear: '<path d="m10 3-1 3-3 1-3-1v4l3 2-1 3-2 1 3 4 3-1 3 2 1 1 3-2v-3l3-2 3-1-1-4-3-1-2-3V3h-6Z"/><circle cx="12" cy="12" r="3"/>',
    build: '<path d="m3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5M12 12v10"/>',
    pause: '<path d="M7 4h3v16H7zm7 0h3v16h-3z"/>',
    sound: '<path d="M3 9h4l5-4v14l-5-4H3V9Zm13-2c4 2 4 8 0 10m3-13c6 4 6 12 0 16"/>',
    mute: '<path d="M3 9h4l5-4v14l-5-4H3V9Zm13 0 6 6m0-6-6 6"/>',
    help: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 8c0-3 6-3 6 0 0 2-3 2-3 5m0 3v1"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    belt: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="m6 9 3 3-3 3m6-6 3 3-3 3m6-6 3 3-3 3"/>',
    robot: '<path d="M4 10h16v10H4V10Zm3 0V6h10v4m-5-4V2M8 14v2m8-2v2m-7 3h6M1 13v5m22-5v5"/>',
    rover: '<path d="M3 8h18v10H3V8Zm4 0V4h10v4M6 18v3m12-3v3M1 15h22M7 11h10"/>',
    map: '<path d="m2 5 7-3 6 3 7-3v17l-7 3-6-3-7 3V5Zm7-3v17m6-14v17"/>',
    up: '<path d="m5 15 7-7 7 7"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    trash: '<path d="M4 6h16M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${paths[name] ?? paths.brush}</svg>`;
};

let saved: GameState | null = null;
try { saved = loadFromStorage(localStorage); } catch { /* Play remains available without storage. */ }
let state = saved ?? createGame();
let started = false;
let dialog: 'shop' | 'garage' | 'terminal' | 'help' | 'pause' | 'reset' | 'complete' | 'production' | 'overview' | 'generation' | null = null;
let resetStart: 'fresh' | 'developed' = 'fresh';
interface GenerationSession {
  controller: AbortController;
  seed: number;
  origin: 'title' | 'pause';
  phase: 'running' | 'error';
  progress: DevelopedProgress | null;
}
let generationSession: GenerationSession | null = null;
let buildMode: { kind: BuildKind | 'remove'; dir: Direction } | null = null;
let pointer: Vec | null = null;
let inspectionId: number | null = null;
let mouseCleaning = false;
let soundEnabled = true;
let audio: AudioContext | null = null;
let music: BackgroundMusic | null = null;
let camera = { x: state.player.x - 360, y: state.player.y - 220 };
const keys = new Set<string>();
let lastEventId = 0;
let lastSaveTime = 0;
let lastHudTime = -1;
let previousCleaned = state.cleaned;
let lastSound = 0;
let completionShown = state.completed;
let focusBeforeDialog: HTMLElement | null = null;

$('#app').innerHTML = `
  <main class="game-shell">
    <header class="topbar">
      <a class="brand" href="https://prodcontest.com/" target="_blank" rel="noreferrer" aria-label="Олимпиада PROD"><span class="brand-prod">PROD<span class="brand-dot">↗</span></span><span class="brand-game">SWEEPERS<span>БОЛЬШОЙ МИР. МАЛЕНЬКАЯ ЩЁТКА.</span></span></a>
      <div class="top-progress"><span class="eyebrow">МИР СТАНОВИТСЯ ЧИЩЕ</span><div><span id="clean-percent">0,0</span><span class="percent-sign">%</span><span class="progress-track"><i id="global-progress"></i></span></div></div>
      <div class="top-actions"><div class="credits-pill">${icon('coin', 23)}<span data-testid="credits" id="credits">0</span><span class="credits-label">КРЕДИТЫ</span></div><button class="icon-button" id="sound" aria-label="Выключить звук" title="Звук">${icon('sound')}</button><button class="icon-button" id="production-guide" aria-label="Карта производственных цепочек" title="Карта цепочек [C]">${icon('build')}</button><button class="icon-button" id="help" aria-label="Как играть" title="Как играть [?]">${icon('help')}</button><button class="icon-button" id="pause" aria-label="Пауза" title="Пауза [Esc]">${icon('pause')}</button></div>
    </header>
    <section class="world-stage" aria-label="Открытый мир PROD">
      <canvas id="world" aria-label="Игровой мир: Лотти очищает PROD от багов" tabindex="0"></canvas>
      <div class="world-vignette"></div>
      <div id="game-hud" data-testid="game-hud" class="world-hud" hidden>
        <button id="mission-toggle" class="mission-toggle" aria-label="Текущее задание" aria-controls="mission-panel" aria-expanded="false" title="Текущее задание">i</button><aside id="mission-panel" class="mission-panel" hidden><div class="eyebrow"><span class="status-light"></span> ЛОТТИ НА СМЕНЕ <span class="mission-index">01</span><button id="mission-close" class="mission-close" aria-label="Скрыть подсказку">${icon('close', 12)}</button></div><h2 id="mission-title">Начни с малого</h2><p id="mission-text">Собери первые 20 багов.</p><div class="mission-meter"><i id="mission-progress"></i></div><div class="mission-bottom"><span id="mission-count">0 / 20</span><span id="mission-reward">ПЕРВЫЙ ЧИСТЫЙ СЛЕД</span></div></aside>
        <aside class="map-panel"><div class="map-heading"><span>КАРТА PROD</span><span class="live-label"><i></i> LIVE</span></div><canvas id="minimap" width="160" height="112" aria-label="Мини-карта мира"></canvas><div class="map-legend"><span><i class="map-mint"></i> база</span><span><i class="map-coral"></i> баги</span><span><i class="map-white"></i> ты</span></div></aside>
        <div class="region-label"><span class="region-coordinates" id="coordinates">${Math.round(state.player.x)} / ${Math.round(state.player.y)}</span><span id="region">ЦЕНТРАЛЬНОЕ ПЛАТО</span><span class="region-subtitle">ОТКРЫТЫЙ МИР / PROD</span></div>
        <div id="building-inspection"></div><div class="context-pill" id="context-action"></div>
        <div class="robot-pill" data-testid="robot-status" id="robot-status" hidden>${icon('robot', 17)}<span id="robot-text">Лоттик убирает</span><i class="status-light"></i></div>

        <div class="bag-panel"><div class="bag-icon">${icon('bag', 26)}</div><div class="bag-content"><div class="bag-heading"><span>КОНТЕЙНЕР БАГОВ</span><span><b data-testid="bag-count" id="bag-count">0</b><span class="muted"> / <span id="bag-capacity">${getCapacity(state)}</span></span></span></div><div class="bag-meter"><i id="bag-progress"></i></div><span id="bag-tip">Маленькая щётка — большое начало</span></div></div>
        <div id="toasts" class="toasts" aria-live="polite"></div>
      </div>
      <div id="build-panel" class="build-panel" hidden><div class="build-heading"><span class="eyebrow">ФАБРИКА КАЧЕСТВА</span><button id="close-build" class="icon-button" aria-label="Закрыть строительство">${icon('close', 16)}</button></div><div class="build-economy"><span>Баги <b>1</b></span> → <span>Отчёты <b>3</b></span> → <span>Автотесты <b>7</b></span></div><div class="build-items">${(Object.keys(BUILDINGS) as BuildKind[]).map(kind => `<button class="build-item" data-build="${kind}" aria-label="Выбрать ${BUILDINGS[kind].name}">${icon(kind === 'belt' ? 'belt' : kind === 'receiver' ? 'bag' : kind === 'tester' ? 'check' : 'gear')}<span>${BUILDINGS[kind].name}<small>${BUILDINGS[kind].price} кр.</small></span></button>`).join('')}<button class="build-item" data-build="remove" aria-label="Выбрать Демонтаж">${icon('trash')}<span>Демонтаж<small>Возврат кредитов</small></span></button></div><button class="chain-guide-button" data-production-guide aria-label="Посмотреть цепочки">${icon('map', 15)} Карта цепочек <kbd>C</kbd></button><div class="build-tip" id="build-tip">Приёмник → анализатор → тестовый стенд → терминал</div><button id="rotate-build" class="rotate-button" hidden>R <span>Повернуть</span> <span id="build-direction">→</span></button><p class="build-help">Автосоединение с любой стороны. При нескольких выходах капсулы идут по очереди.<br>ЛКМ — строить; Демонтаж — удалить с грузом.<br>Груз после демонтажа хранится у терминала до продажи.</p></div>
    </section>
    <footer class="bottom-bar"><div class="tool-display">${icon('brush', 24)}<div><span class="eyebrow" id="tool-mode">В РУКАХ</span><span data-testid="equipped-tool" id="equipped-tool">Зубная щётка</span></div></div><div class="hotbar" aria-label="Инструменты">${(Object.keys(TOOLS) as ToolId[]).map((tool, i) => `<button class="tool-slot${i === 0 ? ' selected' : ''}" data-tool="${tool}" aria-label="Взять ${TOOLS[tool].name}" title="${TOOLS[tool].name} [${i + 1}]"><kbd>${i + 1}</kbd><span class="pixel-brush brush-${i}"><i></i></span><span class="slot-lock">·</span></button>`).join('')}<button class="tool-slot vehicle-slot" id="vehicle-toggle" aria-label="Сесть в машину" title="Машина [V]" disabled><kbd>V</kbd>${icon('rover', 26)}</button></div><div class="footer-actions"><button class="action-button" id="overview-toggle" aria-label="Обзор мира">${icon('map')}<span>Обзор</span><kbd>Tab</kbd></button><button class="action-button" id="workshop" aria-label="Мастерская">${icon('gear')}<span>Мастерская</span><kbd>M</kbd></button><button class="action-button" id="build-toggle" aria-label="Строительство">${icon('build')}<span>Строить</span><kbd>B</kbd></button></div></footer>
    <div class="statusbar"><span><i class="status-light"></i> <span id="save-status">АВТОСОХРАНЕНИЕ ВКЛЮЧЕНО</span></span><span class="keyboard-hints" id="movement-hints"><b>WASD</b> идти <i>·</i> <b>ПРОБЕЛ / ЛКМ</b> убирать <i>·</i> <b>E</b> сдать баги</span><span>СДЕЛАНО С ЛЮБОВЬЮ К PROD <span class="coral">✳</span></span></div>
  </main>
  <section class="title-screen" id="title-screen" aria-label="Добро пожаловать в PROD Sweepers">
    <div class="title-noise"></div><div class="title-content"><span class="title-kicker"><i class="status-light"></i> ОДИН ЛОТТИ. ЦЕЛЫЙ МИР БАГОВ.</span><h1><span>PROD</span><span>SWEEPERS<span class="title-star">✳</span></span></h1><p class="title-tagline">Большой мир.<br>Маленькая щётка.</p><p class="title-description">Под слоем багов скрывается прекрасный PROD.<br>Очисти его. Прокачай щётку. Доверь рутину роботам.</p><button class="start-button" id="start-game">${saved ? 'Продолжить' : 'Начать уборку'}${icon('arrow', 23)}</button>${saved ? '<button id="new-from-title" class="text-button">Начать новый мир</button>' : ''}<button id="developed-from-title" class="developed-start-button" aria-describedby="developed-start-description">Начать с развитой базой ${icon('arrow', 17)}</button><p id="developed-start-description" class="developed-start-description">Настоящая смена: четыре ветки и пять роботов.<br>Можно следить за прогрессом и отменить.</p><div class="title-controls"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> перемещаться</span><span><kbd>ПРОБЕЛ</kbd> убирать</span><span>Играй в своём темпе</span></div></div>
    <div class="title-sticker"><div class="sticker-label">ЗНАКОМЬСЯ,<br>ЭТО ЛОТТИ <span>↙</span></div><canvas id="title-lotti" width="240" height="240" aria-hidden="true"></canvas><div class="sticker-caption">ЗУБНАЯ ЩЁТКА В КОМПЛЕКТЕ</div></div><div class="title-footer"><span>В МИРЕ PROD ВСЕГДА ЕСТЬ ЧТО ПОЧИНИТЬ.</span><span>ПИКСЕЛЬНОЕ ПРИКЛЮЧЕНИЕ / 2026</span></div>
  </section>
  <div id="modal-root"></div>
`;

const world = $<HTMLCanvasElement>('#world');
const ctx = world.getContext('2d')!;
const miniCtx = $<HTMLCanvasElement>('#minimap').getContext('2d')!;
const titleCtx = $<HTMLCanvasElement>('#title-lotti').getContext('2d')!;
function resize() {
  const rect = world.getBoundingClientRect();
  const scale = rect.width < 600 ? 1.15 : 1.6;
  world.width = Math.max(260, Math.round(rect.width / scale));
  world.height = Math.max(240, Math.round(rect.height / scale));
  ctx.imageSmoothingEnabled = false;
  camera = { x: Math.max(0, Math.min(WORLD_W - world.width, state.player.x - world.width / 2)), y: Math.max(0, Math.min(WORLD_H - world.height, state.player.y - world.height / 2)) };
}
new ResizeObserver(resize).observe(world);
resize();

function getAudio(): AudioContext | null {
  try {
    audio ??= new AudioContext();
    music ??= new BackgroundMusic(audio);
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    return audio;
  } catch { return null; }
}

function syncMusic() {
  const playing = started && soundEnabled && (!dialog || dialog === 'overview') && !document.hidden;
  if (playing) getAudio();
  music?.setPlaying(playing);
}

function beep(kind: 'clean' | 'credit' | 'click') {
  if (!soundEnabled) return;
  try {
    const context = getAudio();
    if (!context) return;
    const osc = context.createOscillator(); const gain = context.createGain();
    const now = context.currentTime;
    osc.type = kind === 'clean' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(kind === 'credit' ? 660 : kind === 'clean' ? 140 + Math.random() * 120 : 440, now);
    osc.frequency.exponentialRampToValueAtTime(kind === 'credit' ? 1100 : 90, now + .09);
    gain.gain.setValueAtTime(kind === 'clean' ? .03 : .065, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + .12);
    osc.connect(gain); gain.connect(context.destination); osc.start(); osc.stop(now + .13);
  } catch { /* Audio is optional. */ }
}

function save() {
  if (generationSession) return;
  let ok = false;
  try { ok = saveToStorage(localStorage, state); } catch { /* Browser may disable storage. */ }
  $('#save-status').textContent = ok ? 'ПРОГРЕСС СОХРАНЁН' : 'СОХРАНЕНИЕ НЕДОСТУПНО';
  lastSaveTime = state.time;
}
function toast(text: string, positive = true) {
  const el = document.createElement('div'); el.className = `toast ${positive ? '' : 'toast-error'}`;
  el.innerHTML = `${icon(positive ? 'check' : 'help', 15)}<span></span>`;
  el.querySelector('span')!.textContent = text;
  $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstElementChild?.remove();
  setTimeout(() => el.remove(), 4200);
}
function action(result: ActionResult) {
  toast(result.message, result.ok); if (result.ok) { beep('click'); save(); }
  updateHud();
}
function clearInput() { keys.clear(); mouseCleaning = false; }
function start() {
  if (generationSession) return;
  started = true; dialog = null; $('#title-screen').hidden = true; $('#game-hud').hidden = false;
  clearInput(); resize(); save(); beep('click'); syncMusic(); world.focus({ preventScroll: true }); updateHud();
}
$('#start-game').addEventListener('click', start);
function commitWorld(next: GameState) {
  state = next;
  saved = null; lastEventId = Math.max(0, ...state.events.map(event => event.id)); lastSaveTime = 0; previousCleaned = state.cleaned; completionShown = false;
  buildMode = null; pointer = null; focusBeforeDialog = null;
  closeBuildingDetails();
  $('#build-panel').hidden = true; $('#mission-panel').hidden = true;
  $('#mission-toggle').setAttribute('aria-expanded', 'false'); $('#build-toggle').classList.remove('active');
  world.classList.remove('building'); $('#modal-root').innerHTML = ''; $('#toasts').innerHTML = '';
  start();
}
function replaceWorld(kind: 'fresh' | 'developed') {
  if (generationSession) return;
  if (kind === 'developed') beginDevelopedGeneration();
  else commitWorld(createGame(Date.now() >>> 0));
}
function requestNewWorld(kind: 'fresh' | 'developed') {
  if (generationSession) return;
  resetStart = kind;
  if (kind === 'developed' && !saved && !started) replaceWorld(kind);
  else openDialog('reset');
}

function generationGoal(goal: string | null): string {
  const descriptions: Record<string, string> = {
    handbrush: 'Лотти копит на ручную щётку', broom: 'Переходим к большой щётке', widebrush: 'Покупаем турбощётку',
    capacity: 'Улучшаем контейнеры', capacity1: 'Готовим вместительные контейнеры', capacity2: 'Готовим контейнеры для большой техники',
    speed: 'Улучшаем скорость', speed1: 'Улучшаем скорость', compact: 'Покупаем мини-уборщик', vehicle: 'Покупаем уборочную машину',
    robot: 'Подключаем первого помощника', robot2: 'Покупаем второй робот-пылесос', industrialRobot: 'Готовим первого Лоттика PRO', industrialRobot2: 'Усиливаем добычу вторым PRO', industrialRobot3: 'Собираем полный флот: третий PRO',
    analyzer: 'Строим линию анализа', analysis: 'Строим линию анализа', analysis2: 'Строим вторую линию анализа',
    tester: 'Добавляем автоматические тесты', tester2: 'Добавляем второй тестовый стенд', factory: 'Строим производственную линию',
    frontierNetwork: 'Строим четыре ветки и дальние магистрали', handoff: 'Возвращаемся на базу',
  };
  return goal ? descriptions[goal] ?? (/[а-яё]/i.test(goal) ? goal : 'Лотти собирает баги и развивает фабрику') : 'Завершаем смену и готовим мир к игре';
}
function updateGenerationProgress(session: GenerationSession) {
  if (generationSession !== session) return;
  const progress = session.progress;
  const percent = progress ? Math.floor(Math.max(0, Math.min(99, progress.percent))) : 0;
  const bar = $('[data-testid="generation-progress"]');
  bar.setAttribute('aria-valuenow', String(percent));
  bar.setAttribute('aria-valuetext', progress ? `${Math.floor(progress.elapsedSeconds / 60)} минут смены, ${percent}%` : 'Начинаем смену');
  bar.querySelector<HTMLElement>('i')!.style.width = `${percent}%`;
  $('#generation-percent').textContent = `${percent}%`;
  const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  $('[data-testid="generation-time"]').textContent = progress ? `${minutes(progress.elapsedSeconds)} · ориентир ${Math.ceil(progress.targetSeconds / 60)} мин` : 'Запускаем смену…';
  $('[data-testid="generation-goal"]').textContent = progress ? generationGoal(progress.goal) : 'Лотти берёт зубную щётку';
}
function renderGeneration(session: GenerationSession) {
  const failed = session.phase === 'error';
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal modal-generation" role="dialog" aria-modal="true" aria-label="Готовим развитый мир" data-testid="generation-panel" aria-busy="${!failed}"><div class="modal-heading"><div><span class="eyebrow">PROD SWEEPERS / НАСТОЯЩАЯ СМЕНА</span><h2>Готовим развитый мир</h2></div><span class="generation-symbol${failed ? ' failed' : ''}" aria-hidden="true">${icon(failed ? 'help' : 'gear', 28)}</span></div><p class="modal-intro">Лотти собирает баги, строит фабрику и покупает улучшения по обычным правилам игры. Продолжишь смену с большой параллельной фабрикой, двумя роботами-пылесосами и тремя PRO.</p><div class="generation-clock"><span>ПРОЖИТО В ИГРЕ</span><strong data-testid="generation-time">Запускаем смену…</strong><b id="generation-percent">0%</b></div><div class="generation-progress" data-testid="generation-progress" role="progressbar" aria-label="Прогресс подготовки мира" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div><p class="generation-goal" data-testid="generation-goal" role="status">Лотти берёт зубную щётку</p>${failed ? '<p class="generation-error" role="alert">Не удалось подготовить развитый мир. Текущий мир и сохранение остались на месте. Можно попробовать ещё раз.</p><button class="start-button" data-retry-generation aria-label="Повторить подготовку мира">Повторить подготовку '+icon('arrow', 18)+'</button>' : '<p class="generation-note">Смена идёт ускоренно. Можно отменить в любой момент — текущий мир и сохранение останутся на месте.</p>'}<button class="text-button generation-cancel" data-cancel-generation aria-label="Отменить подготовку мира">${failed ? session.origin === 'title' ? 'На титульный экран' : 'Вернуться к текущему миру' : 'Отменить подготовку'}</button></section></div>`;
  $('[data-cancel-generation]').addEventListener('click', cancelDevelopedGeneration);
  $('[data-retry-generation]')?.addEventListener('click', () => {
    if (generationSession !== session || session.phase !== 'error') return;
    generationSession = null; beginDevelopedGeneration(session.seed, session.origin);
  });
  updateGenerationProgress(session);
  $<HTMLButtonElement>(failed ? '[data-retry-generation]' : '[data-cancel-generation]').focus();
}
function beginDevelopedGeneration(seed = Date.now() >>> 0, origin: GenerationSession['origin'] = started ? 'pause' : 'title') {
  if (generationSession) return;
  const session: GenerationSession = { controller: new AbortController(), seed, origin, phase: 'running', progress: null };
  generationSession = session; dialog = 'generation'; clearInput(); syncMusic();
  $<HTMLButtonElement>('#developed-from-title').disabled = true;
  renderGeneration(session);
  void generateDevelopedGame({ seed, signal: session.controller.signal, onProgress: progress => {
    if (generationSession !== session) return;
    session.progress = progress; updateGenerationProgress(session);
  } }).then(next => {
    if (generationSession !== session || session.controller.signal.aborted) return;
    generationSession = null; $<HTMLButtonElement>('#developed-from-title').disabled = false;
    commitWorld(next);
  }).catch(error => {
    if (generationSession !== session || error?.name === 'AbortError') return;
    session.phase = 'error'; renderGeneration(session);
  });
}
function cancelDevelopedGeneration() {
  const session = generationSession;
  if (!session) return;
  generationSession = null; session.controller.abort(); dialog = null; clearInput();
  $('#modal-root').innerHTML = ''; $<HTMLButtonElement>('#developed-from-title').disabled = false;
  if (session.origin === 'pause') openDialog('pause', false);
  else { syncMusic(); $('#developed-from-title').focus(); }
}
$('#new-from-title')?.addEventListener('click', () => requestNewWorld('fresh'));
$('#developed-from-title').addEventListener('click', () => requestNewWorld('developed'));
$('#sound').addEventListener('click', () => {
  soundEnabled = !soundEnabled; $('#sound').innerHTML = icon(soundEnabled ? 'sound' : 'mute');
  $('#sound').setAttribute('aria-label', soundEnabled ? 'Выключить звук' : 'Включить звук');
  $('#sound').setAttribute('aria-pressed', String(soundEnabled));
  syncMusic();
});
$('#sound').title = 'Музыка и звуковые эффекты';
$('#sound').setAttribute('aria-pressed', String(soundEnabled));
$('#production-guide').addEventListener('click', () => openDialog('production'));
for (const button of document.querySelectorAll<HTMLElement>('[data-production-guide]')) button.addEventListener('click', () => openDialog('production'));
$('#help').addEventListener('click', () => openDialog('help'));
$('#pause').addEventListener('click', () => openDialog('pause'));
$('#workshop').dataset.testid = 'station-shop-toggle';
$('#workshop').addEventListener('click', openNearbyShop);
$('#overview-toggle').addEventListener('click', () => openDialog('overview'));
$('#mission-toggle').addEventListener('click', () => setMission($('#mission-panel').hidden));
$('#mission-close').addEventListener('click', () => setMission(false));
$('#build-toggle').addEventListener('click', () => setBuild(buildMode ? null : 'belt'));
$('#close-build').addEventListener('click', () => setBuild(null));
$('#vehicle-toggle').addEventListener('click', () => action(toggleVehicle(state)));

function setMission(show: boolean) {
  if (!started || dialog) return;
  if (show && buildMode) setBuild(null);
  if (show) closeBuildingDetails();
  $('#mission-panel').hidden = !show;
  $('#mission-toggle').setAttribute('aria-expanded', String(show));
}
function setBuild(kind: BuildKind | 'remove' | null) {
  if (!started || dialog) return;
  if (kind) { setMission(false); closeBuildingDetails(); }
  buildMode = kind ? { kind, dir: buildMode?.dir ?? 0 } : null;
  $('#build-panel').hidden = !buildMode;
  $('#build-toggle').classList.toggle('active', !!buildMode);
  $('#world').classList.toggle('building', !!buildMode);
  for (const el of document.querySelectorAll<HTMLElement>('[data-build]')) el.classList.toggle('selected', el.dataset.build === kind);
  if (kind) $('#build-tip').textContent = kind === 'remove' ? 'Демонтаж: груз отправится на склад терминала. Подойди к терминалу и нажми E, чтобы продать его.' : getBuildRequirement(state, kind) ?? BUILDINGS[kind].description;
  clearInput();
}
for (const button of document.querySelectorAll<HTMLElement>('[data-build]')) button.addEventListener('click', () => setBuild(button.dataset.build as BuildKind));
function rotate() {
  if (!buildMode) return;
  if (pointer) {
    const gx = Math.floor(pointer.x / BUILD_CELL), gy = Math.floor(pointer.y / BUILD_CELL);
    if (state.buildings.some(b => b.gx === gx && b.gy === gy)) { action(rotateBuilding(state, gx, gy)); return; }
  }
  buildMode.dir = ((buildMode.dir + 1) % 4) as Direction;
  $('#build-direction').textContent = ['→', '↓', '←', '↑'][buildMode.dir]; beep('click');
}
$('#rotate-build').addEventListener('click', rotate);
for (const button of document.querySelectorAll<HTMLElement>('[data-tool]')) button.addEventListener('click', () => {
  const tool = button.dataset.tool as ToolId;
  if (state.ownedTools.includes(tool)) action(equipTool(state, tool)); else openNearbyShop();
});

function stationDirection(target: Vec): string {
  const dx = target.x - state.player.x, dy = target.y - state.player.y;
  if (Math.abs(dx) < 40) return dy < 0 ? 'на север' : 'на юг';
  if (Math.abs(dy) < 40) return dx < 0 ? 'на запад' : 'на восток';
  return `${dy < 0 ? 'на северо' : 'на юго'}-${dx < 0 ? 'запад' : 'восток'}`;
}
function stationDirections(): string {
  return (Object.keys(STATIONS) as StationKind[]).map(kind => {
    const station = STATIONS[kind];
    return `${station.name}: ${Math.round(Math.hypot(station.x - state.player.x, station.y - state.player.y))} м ${stationDirection(station)}`;
  }).join(' · ');
}
function openNearbyShop() {
  const station = getNearbyStation(state);
  if (station) { openDialog(station === 'workshop' ? 'shop' : 'garage'); return; }
  if (getNearestTerminal(state)) { openDialog('terminal'); return; }
  if (dialog) closeDialog();
  toast(`Покупки доступны на базе. ${stationDirections()}. Подойди и нажми E или M.`, false);
}

const upgradeDetails: Record<string, { name: string; description: string; icon: string }> = {
  capacity: { name: 'Больше контейнер', description: 'Добавляет 50% базовой вместимости рюкзаку и машине. Удваивает запас всех приёмников.', icon: 'bag' },
  speed: { name: 'Быстрые лапки', description: 'Меньше времени на дорогу. Больше — на чистый мир.', icon: 'arrow' },
  compact: { name: VEHICLES.compact.name, description: `Передняя щётка шириной ${VEHICLES.compact.width} м: ${VEHICLES.compact.rate} багов/с, контейнер от ${VEHICLES.compact.capacity}. W/S — газ и задний ход; A/D — руль. При уборке скорость до ${VEHICLES.compact.cleanSpeed} м/с. На стоянке: V.`, icon: 'rover' },
  vehicle: { name: VEHICLES.vehicle.name, description: `Передняя щётка шириной ${VEHICLES.vehicle.width} м: ${VEHICLES.vehicle.rate} багов/с, контейнер от ${VEHICLES.vehicle.capacity}. W/S — газ и задний ход; A/D — руль. При уборке скорость до ${VEHICLES.vehicle.cleanSpeed} м/с. На стоянке: V.`, icon: 'rover' },
  robot: { name: ROBOTS.robot.name, description: `${ROBOTS.robot.rate} багов/с, контейнер ${ROBOTS.robot.capacity}. Ищет баги по всему миру, щётка радиусом ${ROBOTS.robot.radius} м. Отвозит груз в доступный приёмник с линией к любому терминалу.`, icon: 'robot' },
  industrialRobot: { name: ROBOTS.industrialRobot.name, description: `${ROBOTS.industrialRobot.rate} багов/с, контейнер ${ROBOTS.industrialRobot.capacity}. Ищет баги по всему миру, щётка радиусом ${ROBOTS.industrialRobot.radius} м. Передаёт груз удалённо в доступный связанный приёмник.`, icon: 'robot' },
};
function shopCards(station: StationKind) {
  const assortment: UpgradeId[] = station === 'workshop' ? ['handbrush', 'broom', 'widebrush', 'capacity', 'speed'] : ['compact', 'vehicle', 'robot', 'industrialRobot'];
  return assortment.map(id => {
    const tool = id in TOOLS ? TOOLS[id as ToolId] : null;
    const vehicle = id in VEHICLES ? VEHICLES[id as VehicleKind] : null;
    const robot = id in ROBOTS ? ROBOTS[id as RobotKind] : null;
    const robotCount = robot ? state.robots.filter(item => item.kind === id).length : 0;
    const fleetFull = !!robot && state.robots.length >= ECONOMY.maxRobots;
    const replaceSmall = fleetFull && id === 'industrialRobot' && state.robots.some(item => item.kind === 'robot');
    const fleetBlocked = fleetFull && !replaceSmall;
    const details = tool ? { name: tool.name, description: tool.description, icon: 'brush' } : upgradeDetails[id];
    const owned = tool ? state.ownedTools.includes(id as ToolId) : vehicle ? state.vehicles.some(item => item.kind === id) : robot ? false : id === 'capacity' ? state.player.capacityLevel >= 3 : state.player.speedLevel >= 2;
    const price = upgradePrice(state, id);
    const requirement = owned || fleetBlocked ? null : getUpgradeRequirement(state, id);
    const equipped = state.player.tool === id;
    const capacityAfter = id === 'capacity' && state.player.capacityLevel < 3 ? Math.round(getWalkingCapacity(state) / ECONOMY.capacityMultipliers[state.player.capacityLevel] * ECONOMY.capacityMultipliers[state.player.capacityLevel + 1]) : null;
    const level = id === 'capacity' ? `УРОВЕНЬ ${state.player.capacityLevel} / 3` : id === 'speed' ? `УРОВЕНЬ ${state.player.speedLevel} / 2` : tool ? `РАДИУС ${tool.radius} · ${tool.rate} БАГОВ/С · КОНТЕЙНЕР ${tool.capacity}` : vehicle ? `ТЕХНИКА · ${vehicle.speed} М/С` : `ФЛОТ · ${state.robots.length} / ${ECONOMY.maxRobots}`;
    return `<article class="shop-card ${owned ? 'owned' : ''}" data-upgrade="${id}"><div class="shop-card-icon ${id === 'industrialRobot' ? 'industrial-icon' : ''}">${icon(details.icon, id === 'industrialRobot' ? 38 : 32)}</div><div class="shop-card-text"><span class="eyebrow">${level}</span><h3>${details.name}${robot ? ` <span class="shop-owned-count" data-testid="owned-${id}">×${robotCount}</span>` : ''}</h3><p>${details.description}${tool ? ` В комплекте контейнер от ${tool.capacity} багов; улучшения вместимости сохраняются.` : capacityAfter ? ` Пешком: ${getWalkingCapacity(state)} → ${capacityAfter} багов.` : ''}</p>${replaceSmall ? '<p class="fleet-replacement">Заменит одного маленького помощника; груз сохранится.</p>' : ''}${requirement ? `<p class="upgrade-requirement">${requirement}</p>` : ''}${fleetBlocked ? `<p class="upgrade-requirement">Весь флот укомплектован: максимум ${ECONOMY.maxRobots} роботов.</p>` : ''}</div><button class="buy-button ${owned ? 'owned-button' : ''}" data-buy="${id}" aria-label="${replaceSmall ? 'Улучшить робота до Лоттик PRO' : `${owned && tool ? 'Выбрать' : 'Купить'} ${details.name}`}" ${owned ? (tool && !equipped ? '' : 'disabled') : fleetBlocked || requirement || state.credits < price ? 'disabled' : ''}>${fleetBlocked ? `Лимит ${ECONOMY.maxRobots}` : owned ? equipped ? 'В руках' : tool ? 'Выбрать' : 'Куплено' : `${replaceSmall ? '<span class="fleet-upgrade-label">Улучшить ·</span>' : ''}${price.toLocaleString('ru')} <span>кр.</span>`}</button></article>`;
  }).join('');
}
function warehouseCard() {
  const total = Object.values(state.recovered).reduce((sum, units) => sum + units, 0);
  if (!total) return '';
  const value = (Object.keys(MATERIALS) as MaterialKind[]).reduce((sum, material) => sum + state.recovered[material] * MATERIALS[material].value, 0);
  const nearTerminal = !!getNearestTerminal(state);
  return `<section class="warehouse-panel" data-testid="recovered-panel"><div><span class="eyebrow">СКЛАД ВОЗВРАТА</span><p>Груз после демонтажа сохранён. Продай его у терминала клавишей E.${nearTerminal ? '' : ' Вернись на базу.'}</p><div class="warehouse-items">${(Object.keys(MATERIALS) as MaterialKind[]).map(material => `<span style="--material:${MATERIALS[material].color}">${MATERIALS[material].name} <b data-testid="recovered-${material}">${state.recovered[material]}</b></span>`).join('')}</div></div><button class="buy-button" id="sell-recovered" aria-label="Продать груз со склада" ${nearTerminal ? '' : 'disabled'}>Продать · ${value} кр.</button></section>`;
}
function openDialog(kind: Exclude<NonNullable<typeof dialog>, 'generation'>, persist = true) {
  if (generationSession) return;
  if ((kind === 'shop' && getNearbyStation(state) !== 'workshop') || (kind === 'garage' && getNearbyStation(state) !== 'garage')
    || (kind === 'terminal' && !getNearestTerminal(state))) {
    openNearbyShop(); return;
  }
  if (dialog === kind) { closeDialog(); return; }
  closeBuildingDetails();
  focusBeforeDialog = document.activeElement as HTMLElement;
  dialog = kind; clearInput(); syncMusic();
  if (started && persist && !(kind === 'reset' && resetStart === 'developed')) save();
  const title = { shop: STATIONS.workshop.name, garage: STATIONS.garage.name, terminal: 'Терминал продажи', help: 'Как играть', pause: 'Пауза', reset: resetStart === 'developed' ? 'Развитый мир?' : 'Новый мир?', complete: 'PROD сияет!', production: 'Карта производственных цепочек', overview: 'Обзор мира' }[kind];
  let content = '';
  if (kind === 'shop' || kind === 'garage') {
    const station = kind === 'shop' ? 'workshop' : 'garage';
    const place = STATIONS[station];
    const intro = station === 'workshop' ? 'Щётки, контейнеры и быстрые лапки. Всё для твоей следующей смены.' : 'Две машины и до пяти помощников. Купленная техника ждёт на стоянке рядом.';
    content = `<p class="modal-intro">${intro}</p><div class="station-shop-meta"><span class="station-location" data-testid="station-position">${icon('map', 14)} ${place.x} / ${place.y}</span><div class="shop-balance">${icon('coin', 19)}<b id="shop-credits">${Math.floor(state.credits).toLocaleString('ru')}</b> кредитов</div></div>${station === 'garage' ? `<div class="fleet-summary"><span>${icon('robot', 18)} Помощников <b data-testid="robot-count">${state.robots.length} / ${ECONOMY.maxRobots}</b></span><span>Машин <b>${state.vehicles.length} / ${Object.keys(VEHICLES).length}</b></span></div>` : ''}<div class="shop-grid">${shopCards(station)}</div><p class="modal-footnote">${station === 'workshop' ? 'Купленные щётки переключаются клавишами 1–4. Вместимость от лучшей щётки сохраняется. За техникой и роботами загляни в гараж справа в центре базы.' : 'V рядом с машиной — сесть или выйти; W/S — газ и задний ход, A/D — руль. Для уборки удерживай пробел или ЛКМ: машина замедлится. Роботы работают по всему миру; для доставки нужен свободный приёмник с линией к терминалу. Каждый следующий робот того же типа дороже на 20%; первый робот другого типа сохраняет базовую цену.'}</p>`;
  }
  if (kind === 'terminal') {
    const stock = Math.max(0, state.stats.rawSold - state.stats.rawReclaimed);
    const nearTerminal = !!getNearestTerminal(state, state.player, 64);
    const amount = Math.min(ECONOMY.reclaimBatch, stock, Math.max(0, getCapacity(state) - state.player.bag), Math.floor(state.credits / ECONOMY.reclaimPrice));
    content = `<p class="modal-intro">Любой из четырёх терминалов принимает продукцию и груз со склада. Щётки — в центре базы слева, гараж — справа.</p><div class="shop-balance">${icon('coin', 19)}<b id="shop-credits">${Math.floor(state.credits).toLocaleString('ru')}</b> кредитов</div>${warehouseCard()}${stock > 0 ? `<div class="reclaim-panel"><p>В терминале <b data-testid="raw-stock">${stock}</b> сырых багов. Верни их в контейнер по ${ECONOMY.reclaimPrice} кр., чтобы переработать на фабрике.${nearTerminal ? '' : ' Подойди ближе к терминалу.'}</p><button class="buy-button" id="reclaim-bugs" ${!nearTerminal || amount < 1 ? 'disabled' : ''} aria-label="Вернуть баги из терминала">Забрать ${amount} · ${amount * ECONOMY.reclaimPrice} кр.</button></div>` : '<p class="terminal-empty">Возврат сырья появится после первой продажи багов. Груз разобранных построек хранится здесь до продажи.</p>'}<p class="modal-footnote">E у терминала — продать рюкзак и склад. Баги стоят 1 кредит, отчёты — 3, автотесты — 7. Карта производственных цепочек: C.</p>`;
  }
  if (kind === 'production') content = productionGuide(state);
  if (kind === 'overview') content = overviewContent(state);
  if (kind === 'pause') content = `<p class="pause-copy">Даже маленьким лапкам нужен перерыв.<br>Твой мир подождёт.</p><div class="pause-stats"><div><b>${(state.cleaned / Math.max(1, state.totalDirt) * 100).toFixed(1)}%</b><span>мира очищено</span></div><div><b>${state.stats.delivered.toLocaleString('ru')}</b><span>багов сдано</span></div><div><b>${state.discoveries.length}</b><span>мест открыто</span></div></div><button class="start-button" data-resume>Продолжить ${icon('arrow')}</button><button class="text-button" data-reset>Начать новый мир</button><p class="modal-footnote">Прогресс сохраняется автоматически. Мир отдыхает, пока игра закрыта.</p>`;
  if (kind === 'help') content = `<p class="modal-intro">Под багами скрывается прекрасный мир. Поможем ему?</p><div class="help-steps"><article><b>01</b><div><h3>Чисти и исследуй</h3><p>WASD или стрелки — идти. Пробел или левая кнопка мыши — убирать; пешком мышь задаёт направление. В машине W/S — газ и задний ход, A/D — руль. Машина чистит прямоугольной щёткой впереди и замедляется при уборке. Tab открывает большую карту и прогресс.</p></div></article><article><b>02</b><div><h3>Сдавай продукцию на базе</h3><p>На базе четыре терминала по углам. E у любого из них — продать рюкзак и склад после демонтажа. Баги стоят 1 кредит, отчёты — 3, автотесты — 7. M у терминала открывает склад и возврат проданного сырья по ${ECONOMY.reclaimPrice} кредита за штуку. Удалённые приёмники отправляют баги в связанную фабрику.</p></div></article><article><b>03</b><div><h3>Покупай в мастерской и гараже</h3><p>В центре базы слева — ${STATIONS.workshop.name}: щётки, контейнеры и скорость. Справа — ${STATIONS.garage.name}: машины и роботы. Подойди к нужной станции и нажми E или M. Покупки доступны рядом со станцией. Щётки дают контейнеры 120 → 300 → 600 → 1000; переключение на старую щётку сохраняет вместимость. Каждый уровень контейнеров добавляет 50% базового объёма и удваивает приёмники.</p></div></article><article><b>04</b><div><h3>Собери флот и фабрику</h3><p>B — строительство, C — карта цепочек. Первая линия после ручной щётки стоит ${FIRST_LINE_COST} кредитов. Постройки соединяются со всех сторон; несколько выходов получают капсулы по очереди. Демонтаж сохраняет груз на складе терминала. Продай ${ECONOMY.robotReports} отчётов для первого робота, ${ECONOMY.compactReports} — для мини-уборщика, ${ECONOMY.testerReports} — для стенда. Тяжёлая машина открывается после ${ECONOMY.vehicleTests} автотестов и контейнеров II; Лоттик PRO — после неё и ${ECONOMY.robotTests} автотестов. Подробные условия видны в гараже. V рядом с машиной — сесть или выйти. Можно владеть обеими машинами и ${ECONOMY.maxRobots} роботами; следующая покупка того же помощника дороже. Роботы ищут баги по всему миру. Обычный помощник отвозит груз в доступный связанный приёмник, PRO передаёт его удалённо. Приёмник должен вести к любому из четырёх терминалов; если все входы заполнены, робот ждёт с грузом. Tab показывает живую карту: уборка и производство продолжаются. Esc ставит мир на паузу. Сведения о постройке открываются по клику.</p></div></article></div><div class="help-note">Мир ждёт, пока игра закрыта. Покупки — на базе, производство — там, где ты его построишь.</div><button class="chain-guide-button" data-open-production>Посмотреть карту цепочек <kbd>C</kbd></button><button class="start-button" data-resume>Всё понятно ${icon('check')}</button>`;
  if (kind === 'reset') content = `<p class="pause-copy">${resetStart === 'developed' ? 'Начать с развитой базой, фабриками и полным флотом роботов?<br>Текущий прогресс будет заменён развитым миром.' : 'Начать уборку с чистого листа?<br>Текущий прогресс будет заменён новым миром.'}</p><button class="start-button" data-confirm-reset>${resetStart === 'developed' ? 'Начать с развитой базой' : 'Начать новый мир'} ${icon('arrow')}</button><button class="text-button" data-resume>Оставить текущий мир</button>`;
  if (kind === 'complete') content = `<p class="pause-copy">Каждый баг собран. Каждая тропинка чиста.<br>Одна маленькая щётка изменила целый мир.</p><div class="pause-stats"><div><b>${state.cleaned.toLocaleString('ru')}</b><span>багов убрано</span></div><div><b>${Math.round(state.time / 60)}</b><span>минут на смене</span></div></div><button class="start-button" data-resume>Остаться в мире ${icon('arrow')}</button><button class="text-button" data-reset>Начать новое приключение</button>`;
  const stationAttribute = kind === 'shop' ? ' data-station="workshop"' : kind === 'garage' ? ' data-station="garage"' : kind === 'terminal' ? ' data-station="terminal"' : '';
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal modal-${kind}" role="dialog" aria-modal="true" aria-label="${title}"${stationAttribute}><div class="modal-heading"><div><span class="eyebrow">PROD SWEEPERS / ${kind === 'shop' || kind === 'garage' ? 'ПОКУПКИ НА БАЗЕ' : kind === 'terminal' ? 'ПРОДУКЦИЯ И СКЛАД' : 'ТВОЙ МИР'}</span><h2>${title}</h2></div><button class="icon-button" id="close-modal" aria-label="Закрыть">${icon('close')}</button></div>${content}</section></div>`;
  $('[data-open-production]')?.addEventListener('click', () => openDialog('production'));
  $('[data-open-shop]')?.addEventListener('click', openNearbyShop);
  if (kind === 'overview') {
    const map = $<HTMLCanvasElement>('#overview-map');
    drawOverviewMap(map.getContext('2d')!, state);
  }
  $('#close-modal').addEventListener('click', closeDialog);
  $('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) closeDialog(); });
  $('[data-resume]')?.addEventListener('click', closeDialog);
  $('[data-reset]')?.addEventListener('click', () => requestNewWorld('fresh'));
  $('[data-confirm-reset]')?.addEventListener('click', () => replaceWorld(resetStart));
  $('#reclaim-bugs')?.addEventListener('click', () => {
    action(reclaimBugs(state)); dialog = null; openDialog('terminal');
  });
  $('#sell-recovered')?.addEventListener('click', () => {
    action(sellRecovered(state)); dialog = null; openDialog('terminal');
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-buy]')) button.addEventListener('click', () => {
    const id = button.dataset.buy as UpgradeId;
    const owned = id in TOOLS && state.ownedTools.includes(id as ToolId);
    const result = owned ? equipTool(state, id as ToolId) : buyUpgrade(state, id);
    action(result);
    // Re-render prices and availability after a purchase, keeping the dialog open.
    const currentShop = dialog === 'garage' ? 'garage' : 'shop';
    dialog = null; openDialog(currentShop);
  });
  $('#close-modal').focus();
}
function closeDialog() {
  if (generationSession) { cancelDevelopedGeneration(); return; }
  dialog = null; $('#modal-root').innerHTML = ''; clearInput(); syncMusic();
  if (started) world.focus({ preventScroll: true }); else focusBeforeDialog?.focus();
}

function closeBuildingDetails() {
  inspectionId = null; $('#building-inspection').innerHTML = '';
}
function showBuildingDetails(id: number) {
  const building = state.buildings.find(item => item.id === id);
  if (!building) return;
  setMission(false); inspectionId = id;
  $('#building-inspection').innerHTML = `<aside class="building-details" data-testid="building-details" role="region" aria-label="Сведения о постройке"><div class="building-details-heading"><div><span class="eyebrow">ФАБРИКА КАЧЕСТВА</span><h3>${STRUCTURES[building.kind].name}</h3></div><button class="icon-button" id="close-building-details" aria-label="Закрыть сведения о постройке">${icon('close',16)}</button></div><p class="building-details-status" data-building-status></p><p class="building-details-description">${STRUCTURES[building.kind].description}</p><div data-building-content></div></aside>`;
  $('#close-building-details').addEventListener('click', () => { closeBuildingDetails(); world.focus({ preventScroll:true }); });
  updateBuildingDetails();
}
function updateBuildingDetails() {
  if (inspectionId === null) return;
  const building = state.buildings.find(item => item.id === inspectionId);
  if (!building) { closeBuildingDetails(); return; }
  const status = getBuildingStatus(state, building);
  $('[data-building-status]').textContent = status;
  $('[data-building-status]').classList.toggle('blocked', /полн|блок|Нет пути/.test(status));
  const capsules = state.capsules.filter(item => item.gx === building.gx && item.gy === building.gy);
  const inTransit = capsules.reduce((sum,item) => sum + item.units,0);
  const ports = getBuildingConnections(state,building).length;
  const rows: [string,string][] = [];
  let progress = '';
  if (building.kind === 'analyzer' || building.kind === 'tester') {
    const recipe = PROCESSING[building.kind];
    rows.push(['Вход',`${building.buffer} / ${recipe.capacity} · ${MATERIALS[recipe.input].name.toLowerCase()}`],['Выход',`${building.outputBuffer} / ${recipe.capacity} · ${MATERIALS[recipe.output].name.toLowerCase()}`]);
    if (building.processing) {
      const percent = Math.max(0,Math.min(100,100*(1-building.processing.remaining/recipe.cycle)));
      progress = `<div class="inspection-job"><span>В работе · ${building.processing.units} ед.</span><span>${Math.floor(percent)}%</span><div><i style="width:${percent}%"></i></div></div>`;
    }
  } else if (building.kind === 'receiver') rows.push(['Контейнер',`${building.buffer} / ${getReceiverCapacity(state)}`]);
  else if (building.kind === 'uplink') {
    rows.push(...(Object.keys(MATERIALS) as MaterialKind[]).map(material => [`Склад · ${MATERIALS[material].name.toLowerCase()}`,String(state.recovered[material])] as [string,string]));
  }
  if (inTransit) rows.push(['В капсулах',String(inTransit)]);
  rows.push(['Соединения',`${ports} · автоматически`]);
  const note = building.kind === 'uplink' ? 'E — продать рюкзак и склад. M — открыть услуги терминала.'
    : building.kind === 'receiver' ? 'E рядом — сдать баги. Роботам нужен путь от приёмника к терминалу.' : 'Соседние постройки соединяются с любой стороны.';
  $('[data-building-content]').innerHTML = `<dl class="inspection-values">${rows.map(([name,value])=>`<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>${progress}<p class="inspection-note">${note}</p>`;
}

function updateHud() {
  const percent = 100 * state.cleaned / Math.max(1, state.totalDirt);
  $('#clean-percent').textContent = percent.toFixed(1).replace('.', ','); $('#global-progress').style.width = `${percent}%`;
  $('#credits').textContent = Math.floor(state.credits).toLocaleString('ru');
  const capacity = getCapacity(state);
  $('#bag-count').textContent = String(Math.floor(state.player.bag)); $('#bag-capacity').textContent = String(capacity);
  $('#bag-progress').style.width = `${Math.min(100, 100 * state.player.bag / capacity)}%`;
  $('.bag-panel').classList.toggle('full', state.player.bag >= capacity);
  const delivery = state.buildings.filter(b => b.kind === 'uplink' || (b.kind === 'receiver' && b.buffer < getReceiverCapacity(state))).map(b => ({ building: b, distance: Math.hypot(state.player.x - (b.gx * BUILD_CELL + 12), state.player.y - (b.gy * BUILD_CELL + 12)) })).sort((a, b) => a.distance - b.distance)[0];
  const dropoff = delivery ? `${delivery.building.kind === 'receiver' ? 'Приёмник' : 'Терминал'} — ${Math.round(delivery.distance)} м` : 'Вернись на базу';
  const recoveredCount = Object.values(state.recovered).reduce((sum, units) => sum + units, 0);
  $('#bag-tip').textContent = state.player.bag >= capacity ? `Контейнер полон! ${dropoff}` : state.player.bag > 0 ? dropoff : recoveredCount ? `На складе ${recoveredCount} ед. груза · E у терминала` : 'Баги: 1 кр. · отчёты: 3 · автотесты: 7';
  const selectedVehicle = getVehicle(state);
  $('#equipped-tool').textContent = state.player.riding && selectedVehicle ? VEHICLES[selectedVehicle.kind].name : TOOLS[state.player.tool].name;
  $('#tool-mode').textContent = selectedVehicle ? 'ЗА РУЛЁМ' : 'В РУКАХ';
  $('#movement-hints').innerHTML = selectedVehicle
    ? '<b>W / S</b> газ <i>·</i> <b>A / D</b> руль <i>·</i> <b>ПРОБЕЛ / ЛКМ</b> щётка <i>·</i> <b>V</b> выйти'
    : '<b>WASD</b> идти <i>·</i> <b>ПРОБЕЛ / ЛКМ</b> убирать <i>·</i> <b>E</b> сдать баги';
  $('#movement-hints').classList.toggle('driving', !!selectedVehicle);
  $('#movement-hints').title = selectedVehicle ? `При уборке машина замедляется до ${VEHICLES[selectedVehicle.kind].cleanSpeed} м/с. Щётка работает перед машиной.` : '';
  world.classList.toggle('driving', !!selectedVehicle);
  if (selectedVehicle && state.player.bag === 0 && !recoveredCount) $('#bag-tip').textContent = `Щётка впереди · ПРОБЕЛ / ЛКМ · до ${VEHICLES[selectedVehicle.kind].cleanSpeed} м/с`;
  world.setAttribute('aria-label', selectedVehicle ? `Игровой мир: ${VEHICLES[selectedVehicle.kind].name}. W/S — газ и задний ход, A/D — руль, пробел — передняя щётка` : 'Игровой мир: Лотти очищает PROD от багов');
  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    const id = el.dataset.tool as ToolId; const owned = state.ownedTools.includes(id);
    el.classList.toggle('selected', !state.player.riding && state.player.tool === id); el.classList.toggle('locked', !owned);
    el.querySelector('.slot-lock')!.textContent = owned ? '' : '·';
  }
  $<HTMLButtonElement>('#vehicle-toggle').disabled = state.vehicles.length === 0;
  $('#vehicle-toggle').classList.toggle('selected', state.player.riding);
  const nearbyVehicle = selectedVehicle ?? [...state.vehicles].sort((a, b) => Math.hypot(a.x - state.player.x, a.y - state.player.y) - Math.hypot(b.x - state.player.x, b.y - state.player.y))[0];
  $('#vehicle-toggle').setAttribute('aria-label', `${state.player.riding ? 'Выйти из машины' : 'Сесть в машину'}${nearbyVehicle ? `: ${VEHICLES[nearbyVehicle.kind].name}` : ''}`);
  $('#robot-status').hidden = state.robots.length === 0;
  if (state.robots.length) $('#robot-text').textContent = getRobotStatus(state);
  const nearbyStation = getNearbyStation(state);
  const nearTerminal = !!getNearestTerminal(state);
  const shopTarget = nearbyStation ?? (nearTerminal ? 'terminal' : '');
  const shopButton = $('#workshop');
  shopButton.dataset.station = shopTarget;
  shopButton.querySelector('span')!.textContent = nearbyStation === 'garage' ? 'Гараж' : nearbyStation === 'workshop' ? 'Мастерская' : nearTerminal ? 'Терминал' : 'Магазины';
  shopButton.setAttribute('aria-label', nearbyStation ? `Открыть ${nearbyStation === 'garage' ? 'гараж' : 'мастерскую щёток'}` : nearTerminal ? 'Открыть терминал продажи' : 'Магазины на базе');
  shopButton.title = nearbyStation ? `${STATIONS[nearbyStation].name} [E / M]` : nearTerminal ? 'Склад и возврат сырья [M]' : stationDirections();
  for (const el of document.querySelectorAll<HTMLElement>('[data-build]')) {
    const kind = el.dataset.build as BuildKind | 'remove';
    const requirement = kind === 'remove' ? null : getBuildRequirement(state, kind);
    el.classList.toggle('locked', !!requirement); el.title = requirement ?? '';
  }
  if (buildMode && buildMode.kind !== 'remove') $('#build-tip').textContent = getBuildRequirement(state, buildMode.kind) ?? BUILDINGS[buildMode.kind].description;
  const processors = state.buildings.filter(b => b.kind === 'analyzer' || b.kind === 'tester');
  $('#coordinates').textContent = `${Math.round(state.player.x)} / ${Math.round(state.player.y)}`;
  const nearby = state.landmarks.filter(l => Math.hypot(l.x - state.player.x, l.y - state.player.y) < 220).sort((a, b) => Math.hypot(a.x - state.player.x, a.y - state.player.y) - Math.hypot(b.x - state.player.x, b.y - state.player.y))[0];
  $('#region').textContent = nearby?.name.toUpperCase() ?? 'ЦЕНТРАЛЬНОЕ ПЛАТО';
  const placementError = buildMode && buildMode.kind !== 'remove' && pointer
    ? getBuildPlacementError(state, buildMode.kind, Math.floor(pointer.x / BUILD_CELL), Math.floor(pointer.y / BUILD_CELL)) : null;
  const deliveryAction = !!getNearestTerminal(state) || state.buildings.some(building => building.kind === 'receiver' && Math.hypot(state.player.x - (building.gx * BUILD_CELL + 12), state.player.y - (building.gy * BUILD_CELL + 12)) <= 80);
  const context = buildMode ? buildMode.kind === 'remove' ? 'ДЕМОНТАЖ · ЛКМ удалить · груз на склад терминала' : placementError ?? 'АВТОСОЕДИНЕНИЕ · ЛКМ построить · Esc выйти'
    : nearbyStation && !deliveryAction ? `E / M · ${STATIONS[nearbyStation].name}` : deliveryAction ? 'E · СДАТЬ' : getContextAction(state);
  $('#context-action').dataset.station = nearbyStation && !deliveryAction ? nearbyStation : '';
  $('#context-action').textContent = context; $('#context-action').hidden = !context;
  let task = { title: 'Начни с малого', text: 'Выйди за край базы и собери первые 20 багов. Зажми пробел или кнопку мыши.', count: Math.min(state.cleaned, 20), goal: 20, note: 'ПЕРВЫЙ ЧИСТЫЙ СЛЕД' };
  if (state.cleaned >= 20) task = { title: 'Баги — в дело', text: 'Подойди к любому терминалу в углу базы и сдай контейнер: E.', count: Math.min(state.stats.delivered, 1), goal: 1, note: 'КРЕДИТЫ ЗА НАЙДЕННЫЕ БАГИ' };
  const toolRank = Math.max(...state.ownedTools.map(id => Object.keys(TOOLS).indexOf(id)));
  const soldProducts = state.stats.reportsSold + state.stats.testsSold;
  const ownsCompact = state.vehicles.some(vehicle => vehicle.kind === 'compact');
  const ownsHeavy = state.vehicles.some(vehicle => vehicle.kind === 'vehicle');
  if (state.stats.delivered > 0) {
    if (toolRank < 1) task = { title: 'Пора расти', text: 'Ручная щётка ждёт в мастерской слева в центре базы. Подойди и нажми E или M.', count: Math.min(state.credits, TOOLS.handbrush.price), goal: TOOLS.handbrush.price, note: 'МАСТЕРСКАЯ ЩЁТОК · E / M' };
    else if (!processors.some(b => b.kind === 'analyzer')) task = { title: 'Первая фабрика', text: 'Приёмник → анализатор → конвейер → терминал. Отчёты приносят по 3 кредита. Схема сборки: C.', count: Math.min(state.credits, FIRST_LINE_COST), goal: FIRST_LINE_COST, note: `ПЕРВАЯ ЛИНИЯ · ${FIRST_LINE_COST} КР. · B` };
    else if (!state.robots.length && soldProducts < ECONOMY.robotReports) task = { title: 'Первый помощник', text: 'Продай отчёты: обычный робот доступен уже в начале фабрики.', count: soldProducts, goal: ECONOMY.robotReports, note: 'РОБОТ-ПЫЛЕСОС · ГАРАЖ' };
    else if (!state.robots.length) task = { title: 'Делегируй рутину', text: getUpgradeRequirement(state, 'robot') ?? 'Загляни в гараж справа в центре базы. Робот исследует весь мир и отвозит груз в приёмник, связанный с терминалом.', count: Math.min(state.credits, upgradePrice(state, 'robot')), goal: upgradePrice(state, 'robot'), note: 'ГАРАЖ · E / M' };
    else if (!ownsCompact && soldProducts < ECONOMY.compactReports) task = { title: 'Для больших рейсов', text: 'Следующие продажи откроют мини-уборщик — небольшую машину для дальних участков.', count: soldProducts, goal: ECONOMY.compactReports, note: 'МИНИ-УБОРЩИК · ГАРАЖ' };
    else if (!ownsCompact && state.player.capacityLevel < 1) task = { title: 'Подготовь контейнеры', text: 'Первый уровень контейнеров открывает мини-уборщик. Покупка — в мастерской щёток.', count: Math.min(state.credits, upgradePrice(state, 'capacity')), goal: upgradePrice(state, 'capacity'), note: 'КОНТЕЙНЕРЫ I · МАСТЕРСКАЯ' };
    else if (!ownsCompact) task = { title: 'Маленькая большая машина', text: 'Мини-уборщик ждёт в гараже. После покупки подойди к нему и нажми V.', count: Math.min(state.credits, VEHICLES.compact.price), goal: VEHICLES.compact.price, note: 'ГАРАЖ · E / M' };
    else if (soldProducts < ECONOMY.testerReports) task = { title: 'Отчёты — в продажу', text: 'Приёмник → анализатор → терминал. Продажи откроют тестовый стенд.', count: soldProducts, goal: ECONOMY.testerReports, note: 'ОТЧЁТ = 3 КРЕДИТА' };
    else if (!processors.some(b => b.kind === 'tester')) task = { title: 'Следующий уровень', text: 'Добавь тестовый стенд после анализатора. Проведи выход до терминала.', count: Math.min(state.credits, BUILDINGS.tester.price), goal: BUILDINGS.tester.price, note: `ТЕСТОВЫЙ СТЕНД · ${BUILDINGS.tester.price} КР. · B` };
    else if (state.stats.testsSold < ECONOMY.vehicleTests) task = { title: 'Проверено автоматически', text: 'Продай автотесты, чтобы открыть уборочную машину. Следи за очередями.', count: state.stats.testsSold, goal: ECONOMY.vehicleTests, note: 'АВТОТЕСТ = 7 КРЕДИТОВ' };
    else if (toolRank < 2) task = { title: 'Большой размах', text: 'Большая щётка в мастерской ускорит уборку и откроет тяжёлую технику.', count: Math.min(state.credits, TOOLS.broom.price), goal: TOOLS.broom.price, note: 'БОЛЬШАЯ ЩЁТКА · МАСТЕРСКАЯ' };
    else if (state.player.capacityLevel < 2) task = { title: 'Готовь логистику', text: `Улучши вместимость до второго уровня: запас приёмников вырастет до ${RECEIVER_CAPACITY * 4} багов.`, count: Math.min(state.credits, upgradePrice(state, 'capacity')), goal: upgradePrice(state, 'capacity'), note: `КОНТЕЙНЕРЫ ${state.player.capacityLevel + 1} · M` };
    else if (!ownsHeavy) task = { title: 'Тяжёлый подход', text: `Уборочная машина в гараже: ${VEHICLES.vehicle.capacity} багов за рейс до улучшений и широкий захват.`, count: Math.min(state.credits, VEHICLES.vehicle.price), goal: VEHICLES.vehicle.price, note: 'УБОРОЧНАЯ МАШИНА · ГАРАЖ' };
    else if (state.stats.testsSold < ECONOMY.robotTests) task = { title: 'Профессиональная смена', text: 'Нарасти продажи автотестов для Лоттика PRO. Он ищет баги по всему миру и передаёт груз в связанный приёмник удалённо.', count: state.stats.testsSold, goal: ECONOMY.robotTests, note: 'ЛОТТИК PRO · ГАРАЖ' };
    else if (!state.robots.some(robot => robot.kind === 'industrialRobot') && state.robots.length < ECONOMY.maxRobots) task = { title: 'Лоттик PRO', text: 'Большой помощник доступен в гараже. У флотилии общий лимит: пять роботов.', count: Math.min(state.credits, upgradePrice(state, 'industrialRobot')), goal: upgradePrice(state, 'industrialRobot'), note: 'ПРОМЫШЛЕННЫЙ ПОМОЩНИК · ГАРАЖ' };
    else task = { title: 'Уборочная империя', text: 'Расширяй фабрику и добавляй приёмники: так роботы реже ждут свободного входа. Живая карта мира — Tab.', count: Math.round(percent * 10) / 10, goal: 100, note: 'БОЛЬШЕ ЛИНИЙ — БОЛЬШЕ ВОЗМОЖНОСТЕЙ' };
  }
  $('#mission-title').textContent = task.title; $('#mission-text').textContent = task.text;
  $('#mission-count').textContent = `${task.count} / ${task.goal}`; $('#mission-reward').textContent = task.note;
  $('#mission-progress').style.width = `${Math.min(100, task.count / task.goal * 100)}%`;
  updateBuildingDetails();
}

function pointerWorld(event: PointerEvent | MouseEvent) {
  const r = world.getBoundingClientRect();
  return { x: camera.x + (event.clientX - r.left) * world.width / r.width, y: camera.y + (event.clientY - r.top) * world.height / r.height };
}
world.addEventListener('pointermove', event => { pointer = pointerWorld(event); world.classList.toggle('inspectable', !buildMode && !!hitTestBuilding(state,pointer)); });
world.addEventListener('pointerleave', () => { if (!mouseCleaning) pointer = null; world.classList.remove('inspectable'); });
world.addEventListener('pointerdown', event => {
  if (!started || dialog) return;
  event.preventDefault(); pointer = pointerWorld(event); world.focus({ preventScroll: true });
  if (event.button === 2) { rotate(); return; }
  if (buildMode) {
    const gx = Math.floor(pointer.x / BUILD_CELL), gy = Math.floor(pointer.y / BUILD_CELL);
    action(buildMode.kind === 'remove' ? removeBuilding(state, gx, gy) : placeBuilding(state, buildMode.kind, gx, gy, buildMode.dir));
  } else {
    const building = hitTestBuilding(state,pointer);
    if (building) { mouseCleaning = false; showBuildingDetails(building.id); return; }
    closeBuildingDetails(); mouseCleaning = true; world.setPointerCapture(event.pointerId);
  }
});
window.addEventListener('pointerup', event => { if (event.button === 0) mouseCleaning = false; });
window.addEventListener('pointercancel', clearInput);
world.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('blur', () => { clearInput(); if (started && (!dialog || dialog === 'overview')) openDialog('pause'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && started) { save(); if (!dialog || dialog === 'overview') openDialog('pause'); } });
window.addEventListener('pagehide', () => {
  music?.setPlaying(false);
  if (generationSession) { cancelDevelopedGeneration(); return; }
  if (started) save();
});

document.addEventListener('keydown', event => {
  if (event.code === 'Escape' && dialog === 'overview') { event.preventDefault(); openDialog('pause'); return; }
  if (event.code === 'Tab' && dialog === 'overview' && !event.shiftKey) { event.preventDefault(); if (!event.repeat) closeDialog(); return; }
  if (dialog === 'overview' && (event.code === 'KeyM' || event.code === 'KeyC')) { if (!event.repeat) { if (event.code === 'KeyM') openNearbyShop(); else openDialog('production'); } return; }
  if (event.code === 'KeyM' && (dialog === 'shop' || dialog === 'garage' || dialog === 'terminal') && !event.repeat) { closeDialog(); return; }
  if (dialog && event.code === 'Tab') {
    const focusable = Array.from(document.querySelectorAll<HTMLElement>('.modal button:not([disabled]), .modal a'));
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (!started) { if (event.code === 'Escape' && dialog) closeDialog(); return; }
  if (event.code === 'KeyC' && dialog === 'production' && !event.repeat) { closeDialog(); return; }
  if (event.code === 'Escape') { if (dialog) closeDialog(); else if (buildMode) setBuild(null); else if (!$('#mission-panel').hidden) setMission(false); else openDialog('pause'); return; }
  if (dialog) return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.code)) event.preventDefault();
  if (event.repeat) return;
  if (event.code === 'Tab') { openDialog('overview'); return; }
  if (event.code === 'KeyM') { openNearbyShop(); return; }
  if (event.code === 'KeyC') { openDialog('production'); return; }
  if (event.code === 'KeyB') { setBuild(buildMode ? null : 'belt'); return; }
  if (event.code === 'KeyR' && buildMode) { rotate(); return; }
  if (event.code === 'KeyE') {
    const deliveryNearby = !!getNearestTerminal(state) || state.buildings.some(building => building.kind === 'receiver' && Math.hypot(state.player.x - (building.gx * BUILD_CELL + 12), state.player.y - (building.gy * BUILD_CELL + 12)) <= 80);
    if (!deliveryNearby && getNearbyStation(state)) openNearbyShop(); else action(interact(state));
    return;
  }
  if (event.code === 'KeyV') { action(toggleVehicle(state)); return; }
  if (event.code === 'Slash') { openDialog('help'); return; }
  if (/^Digit[1-4]$/.test(event.code)) { action(equipTool(state, (Object.keys(TOOLS) as ToolId[])[Number(event.code.slice(-1)) - 1])); return; }
  keys.add(event.code);
});
document.addEventListener('keyup', event => keys.delete(event.code));

let lastFrame = performance.now();
function frame(now: number) {
  const dt = Math.min(.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
  if (generationSession) { requestAnimationFrame(frame); return; }
  const cleaning = !dialog && !buildMode && (mouseCleaning || keys.has('Space'));
  if (started && (!dialog || dialog === 'overview') && !document.hidden) {
    const dx = dialog ? 0 : Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const dy = dialog ? 0 : Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp'));
    updateGame(state, dt, { dx, dy, clean: cleaning, ...(!dialog && !state.player.riding && mouseCleaning && pointer ? { aimX: pointer.x, aimY: pointer.y } : {}) });
    if (state.cleaned > previousCleaned && now - lastSound > 140) { beep('clean'); lastSound = now; }
    previousCleaned = state.cleaned;
    for (const event of state.events) if (event.id > lastEventId) {
      if (event.kind === 'discover') toast(event.text);
      if (event.kind === 'credit' || event.kind === 'discover') beep('credit');
      lastEventId = Math.max(lastEventId, event.id);
    }
    if (state.time - lastSaveTime > 5) save();
    if (state.completed && !completionShown) { completionShown = true; openDialog('complete'); }
  }
  const targetX = Math.max(0, Math.min(WORLD_W - world.width, state.player.x - world.width / 2));
  const targetY = Math.max(0, Math.min(WORLD_H - world.height, state.player.y - world.height / 2));
  camera.x += (targetX - camera.x) * Math.min(1, dt * 12); camera.y += (targetY - camera.y) * Math.min(1, dt * 12);
  renderWorld(ctx, state, { camera, pointer, cleaning: started && !dialog && cleaning, build: buildMode, showGrid: !!buildMode, paused: !started || !!dialog && dialog !== 'overview' });
  if (now - lastHudTime > 100) {
    updateHud(); renderMinimap(miniCtx, state);
    if (dialog === 'overview') updateOverview($('#modal-root'),state);
    lastHudTime = now;
  }
  if (!started) {
    titleCtx.clearRect(0, 0, 240, 240); titleCtx.imageSmoothingEnabled = false;
    drawLotti(titleCtx, 120, 188, 4.2, now / 1000, 1, false);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
