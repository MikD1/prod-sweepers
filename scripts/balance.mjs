#!/usr/bin/env node
// Deterministic engine benchmark. Fixture financing and injected factory feed are
// isolated from the fresh-world progression replay and disclosed in its output.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const seed = Number(args.seed ?? 42);
const maxSeconds = Number(args.minutes ?? 75) * 60;
const mode = args.mode ?? 'all';
const parallelFactories = Number(args.parallel ?? (mode === 'developed' ? 2 : 1));
const layoutStrategy = args.layout ?? (mode === 'developed' ? 'network' : 'parallel');
const networkWarmup = Number(args.warmup ?? 300);
const networkMeasurement = Number(args.measure ?? 600);
if (!['all', 'network', 'progression', 'developed'].includes(mode)) throw Error('--mode accepts all, network, progression or developed.');
if (mode === 'developed' && (parallelFactories !== 2 || layoutStrategy !== 'network')) throw Error('--mode=developed uses the browser policy: two starter lines and the industrial network.');
if (!Number.isFinite(networkWarmup) || networkWarmup < 0 || !Number.isFinite(networkMeasurement) || networkMeasurement < 10) throw Error('--warmup must be nonnegative and --measure must be at least 10 seconds.');
if (!['parallel', 'network'].includes(layoutStrategy)) throw Error('--layout accepts parallel or network.');
if (![1, 2].includes(parallelFactories)) throw Error('--parallel accepts 1 or 2 factory lines.');
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(maxSeconds) || maxSeconds <= 0) throw Error('Use an unsigned 32-bit --seed and positive --minutes.');
if (args.help === 'true') {
  console.log('npm run balance -- --mode=network [--warmup=300 --measure=600 --seed=42 --json]\nnpm run balance -- --mode=developed [--seed=42 --json]\nnpm run balance -- --mode=progression --parallel=2 --layout=network [--minutes=75 --seed=42 --json]\n--mode=all (default) includes all financed diagnostics, the shared-input comparison and the real fresh-world replay. Network windows are simulated seconds. Developed mode uses the exact browser progression options, including two PRO robots and a safe return on foot.');
  process.exit(0);
}
const jsonOutput = args.json === 'true';
const idle = { dx: 0, dy: 0, clean: false };
const DT = 0.1;

const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
try {
  const engine = await server.ssrLoadModule('/src/game/engine.ts');
  const config = await server.ssrLoadModule('/src/game/types.ts');
  const autoplay = await server.ssrLoadModule('/src/game/autoplay.ts');
  const { createPilot: pilot, drivePilot: drive, metricsSnapshot, progressionSnapshot: snapshot, progressionLayouts, createProgressionReplay, createIndustrialNetworkPlan } = autoplay;
  const { CELL, GRID_W, GRID_H, WORLD_W, WORLD_H, BUILD_CELL, DIRECTIONS, HUB, SPAWN, TOOLS, BUILDINGS, PROCESSING, LOGISTICS, MATERIALS, RECEIVER_CAPACITY, ECONOMY, VEHICLES, ROBOTS, STATIONS, TERMINALS } = config;
  const position = building => ({ x: building.gx * BUILD_CELL + BUILD_CELL / 2, y: building.gy * BUILD_CELL + BUILD_CELL / 2 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const round = number => Math.round(number * 100) / 100;

  const held = state => Object.values(state.recovered ?? {}).reduce((sum, units) => sum + units, 0) + state.player.bag + state.robots.reduce((sum, robot) => sum + robot.bag, 0) + state.capsules.reduce((sum, capsule) => sum + capsule.units, 0) + state.buildings.reduce((sum, building) => sum + building.buffer + building.outputBuffer + (building.processing?.units ?? 0), 0);
  const checkMass = (state, supplied = 0) => {
    const remaining = state.dust.reduce((sum, layers) => sum + layers, 0);
    if (remaining + held(state) + state.stats.delivered - (state.stats.rawReclaimed ?? 0) !== state.totalDirt + supplied) throw Error(`Material conservation failed at ${state.time}s`);
  };

  const fresh = engine.createGame(seed);
  const uplink = state => state.buildings.find(building => building.kind === 'uplink');
  const capacityPrices = [];
  const speedPrices = [];
  for (let level = 0; level < 16; level++) {
    const probe = engine.createGame(seed);
    probe.player.capacityLevel = level;
    const price = engine.upgradePrice(probe, 'capacity');
    if (!Number.isFinite(price)) break;
    capacityPrices.push(price);
  }
  for (let level = 0; level < 16; level++) {
    const probe = engine.createGame(seed);
    probe.player.speedLevel = level;
    const price = engine.upgradePrice(probe, 'speed');
    if (!Number.isFinite(price)) break;
    speedPrices.push(price);
  }
  const equipmentCost = Object.entries(TOOLS).filter(([id]) => id !== 'toothbrush').reduce((sum, [, tool]) => sum + tool.price, 0) + capacityPrices.reduce((sum, price) => sum + price, 0) + speedPrices.reduce((sum, price) => sum + price, 0) + ['compact','vehicle','robot','industrialRobot'].reduce((sum,id)=>sum+engine.upgradePrice(fresh,id),0);
  const proFleetPrices = Array.from({length:ECONOMY.maxRobots},(_,count)=>Math.round(ROBOTS.industrialRobot.price*ECONOMY.robotPriceMultiplier**count/100)*100);
  const maximumFleetEquipmentCost = equipmentCost - ROBOTS.robot.price - ROBOTS.industrialRobot.price + proFleetPrices.reduce((sum,price)=>sum+price,0);
  const { nw, ne, analysisLayout, secondLayout, analysisAnchor } = progressionLayouts();
  function place(state, plan) {
    for (const [kind, gx, gy, dir] of plan) {
      if (state.buildings.some(building => building.gx === gx && building.gy === gy && building.kind === kind)) continue;
      const action = engine.placeBuilding(state, kind, gx, gy, dir);
      if (!action.ok) return action;
    }
    return { ok: true, message: '' };
  }
  function fixturePurchase(state, id) {
    const before = { x:state.player.x, y:state.player.y };
    const station = ['compact','vehicle','robot','industrialRobot'].includes(id) ? STATIONS.garage : STATIONS.workshop;
    Object.assign(state.player,{x:station.x,y:station.y});
    const result = engine.buyUpgrade(state,id);
    Object.assign(state.player,before);
    return result;
  }
  function fundedTools(state) {
    state.credits = 1e9;
    for (const id of ['handbrush', 'broom', 'widebrush']) if (!state.ownedTools.includes(id)) {
      const action = fixturePurchase(state, id);
      if (!action.ok) throw Error(`Fixture could not buy ${id}: ${action.message}`);
    }
  }
  function feedUntilSold(state, receiver, units) {
    const startingSales = state.stats.delivered;
    let supplied = 0;
    let frames = 0;
    while (state.stats.delivered - startingSales < units) {
      const capacity = engine.getReceiverCapacity?.(state) ?? RECEIVER_CAPACITY;
      const amount = Math.min(units - supplied, capacity - receiver.buffer);
      receiver.buffer += amount;
      supplied += amount;
      engine.updateGame(state, DT, idle);
      if (++frames > 200000) throw Error('Fixture production did not drain its supplied input.');
    }
    return supplied;
  }
  function fixtureFactory(stages) {
    const state = engine.createGame(seed);
    fundedTools(state);
    Object.assign(state.player, analysisAnchor);
    const built = place(state, analysisLayout);
    if (!built.ok) throw Error(`Fixture factory blocked: ${built.message}`);
    const receiver = state.buildings.find(building => building.kind === 'receiver' && building.gx === analysisLayout[0][1] && building.gy === analysisLayout[0][2]);
    let qualificationInput = 0;
    if (stages === 2) {
      // Actual report sales qualify the next stage; do not overwrite gate counters.
      qualificationInput += feedUntilSold(state, receiver, ECONOMY?.testerReports ?? 64);
      const [, gx, gy, dir] = analysisLayout[4];
      const removed = engine.removeBuilding(state, gx, gy);
      if (!removed.ok) throw Error(removed.message);
      const tester = place(state, [['tester', gx, gy, dir]]);
      if (!tester.ok) throw Error(`Tester fixture qualification changed: ${tester.message}`);
    }
    const qualificationIds = state.buildings.filter(building => analysisLayout.some(([, gx, gy]) => building.gx === gx && building.gy === gy)).map(building => building.id);
    return { state, receiver, qualificationInput, qualificationIds };
  }

  function fixturePlace(state, plan) {
    const saved = { x: state.player.x, y: state.player.y };
    for (const [kind, gx, gy, dir] of plan) {
      if (state.buildings.some(b => b.gx === gx && b.gy === gy && b.kind === kind)) continue;
      Object.assign(state.player, position({ gx, gy }));
      const built = engine.placeBuilding(state, kind, gx, gy, dir);
      if (!built.ok) throw Error(`Financed fixture placement blocked at ${gx},${gy}: ${built.message}`);
    }
    Object.assign(state.player, saved);
  }
  function sharedInputComparisons() {
    if (typeof createIndustrialNetworkPlan !== 'function') throw Error('Shared industrial network planner is unavailable.');
    const stepSeconds = 0.05;
    const warmupFrames = Math.round(networkWarmup / stepSeconds);
    const measuredFrames = Math.round(networkMeasurement / stepSeconds);
    const warmupSeconds = warmupFrames * stepSeconds;
    const measuredSeconds = measuredFrames * stepSeconds;
    const trunkByDistance = new Map();
    const summaries = [], timelines = new Map(), finiteBatch = [];
    const fixtureDescription = 'Financed tools and plant; tester gate earned from 64 explicitly injected raw sold as reports. Empty, obstacle-free terrain and no landmarks/robots isolate transport. Exactly one receiver; all raw is disclosed external supply. Prices and finite buffers are unchanged; the shared autoplay planner provides disjoint finished-output routes to real fixed terminal ports. Building travel is excluded.';

    function prepare(lanes, remoteDistance, transportOnly = false) {
      const { state, qualificationInput } = fixtureFactory(2);
      for (const building of [...state.buildings]) if (building.kind !== 'uplink') {
        Object.assign(state.player, position(building));
        const removed = engine.removeBuilding(state, building.gx, building.gy);
        if (!removed.ok) throw Error(removed.message);
      }
      state.obstacles = []; state.landmarks = []; state.dust.fill(0); state.totalDirt = 0; state.cleaned = 0;
      const layout = createIndustrialNetworkPlan(state, { lanes, remoteDistance, additionalReceiver: false });
      const canonicalTrunk = JSON.stringify(layout.rawTrunk);
      if (trunkByDistance.has(remoteDistance) && trunkByDistance.get(remoteDistance) !== canonicalTrunk) throw Error('Lane comparison changed its common raw trunk.');
      trunkByDistance.set(remoteDistance, canonicalTrunk);
      const usedOutputs = new Set(), terminalPorts = [];
      for (const lane of layout.lanes) {
        for (const point of lane.outputPath) {
          const key = `${point.gx},${point.gy}`;
          if (usedOutputs.has(key)) throw Error('Finished lanes secretly share an output bottleneck.');
          usedOutputs.add(key);
        }
        const port = lane.outputPath.find(point => Math.abs(point.gx - lane.terminal.gx) + Math.abs(point.gy - lane.terminal.gy) === 1);
        if (!port) throw Error('A finished lane has no adjacent fixed-terminal input port.');
        terminalPorts.push({ gx: port.gx, gy: port.gy, terminal: lane.terminal });
      }
      const plan = transportOnly ? layout.plan.map(([kind, ...cell]) => [kind === 'receiver' ? kind : 'belt', ...cell]) : layout.plan;
      const before = state.credits;
      fixturePlace(state, plan);
      const cost = before - state.credits;
      const componentCounts = Object.fromEntries(Object.keys(BUILDINGS).map(kind => [kind, plan.filter(node => node[0] === kind).length]));
      const listedCost = Object.entries(componentCounts).reduce((sum, [kind, count]) => sum + BUILDINGS[kind].price * count, 0);
      const processors = transportOnly ? 0 : lanes;
      if (cost !== listedCost || componentCounts.receiver !== 1 || componentCounts.analyzer !== processors || componentCounts.tester !== processors) throw Error('Network fixture purchase/components ledger does not match its requested lanes.');
      const receiver = state.buildings.find(b => b.kind === 'receiver');
      if (!receiver || !engine.receiverHasRoute(state, receiver)) throw Error('Network receiver has no typed route to a terminal.');
      checkMass(state, qualificationInput);
      return { state, layout, receiver, cost, componentCounts, terminalPorts, qualificationInput };
    }
    function queues(state) {
      const materials = { raw: state.recovered.raw, report: state.recovered.report, test: state.recovered.test };
      let receiverRaw = 0, machineInput = 0, machineOutput = 0, working = 0;
      for (const b of state.buildings) {
        const recipe = PROCESSING[b.kind];
        if (b.kind === 'receiver') { receiverRaw += b.buffer; materials.raw += b.buffer; }
        if (recipe) {
          materials[recipe.input] += b.buffer + (b.processing?.units ?? 0);
          materials[recipe.output] += b.outputBuffer;
          machineInput += b.buffer; machineOutput += b.outputBuffer; working += b.processing?.units ?? 0;
        }
      }
      for (const capsule of state.capsules) materials[capsule.material] += capsule.units;
      return { receiverRaw, machineInput, machineOutput, working, inTransit: state.capsules.reduce((sum, c) => sum + c.units, 0), materials, total: held(state) };
    }
    function assertFinite(state) {
      for (const b of state.buildings) {
        const recipe = PROCESSING[b.kind];
        if (b.kind === 'receiver' && b.buffer > engine.getReceiverCapacity(state)) throw Error('Receiver overflow in supplied network fixture.');
        if (recipe && (b.buffer > recipe.capacity || b.outputBuffer + (b.processing?.units ?? 0) > recipe.capacity)) throw Error('Processor overflow in supplied network fixture.');
      }
    }
    const definitions = [['short', 360], ['long', 1560]];
    for (const [length, remoteDistance] of definitions) for (const feed of ['saturated', 24, 60, 120]) for (const lanes of [1, 2, 4]) {
      const { state, layout, receiver, cost, componentCounts, terminalPorts, qualificationInput } = prepare(lanes, remoteDistance);
      const startTime = state.time, startingSales = state.stats.delivered, startingTests = state.stats.testsSold;
      const startingEarned = state.earned, startingCredits = state.credits, startingRaw = state.stats.rawSold, startingReports = state.stats.reportsSold;
      let offered = 0, supplied = 0, externalBacklog = 0, maxReceiver = 0, firstTestSeconds = null, observedGrossPaybackSeconds = null;
      let warm = null, half = null, rawPacketUnits = 0, rawPackets = 0, largeRawPackets = 0;
      const laneProcessed = Array(lanes).fill(0), revenueTimeline = [0];
      const testers = layout.lanes.map(lane => state.buildings.find(b => b.gx === lane.tester.gx && b.gy === lane.tester.gy));
      const wallStarted = performance.now();
      const capture = () => ({ tests: state.stats.testsSold, earned: state.earned, accepted: supplied, offered, externalBacklog, pending: held(state), rawPacketUnits, rawPackets, largeRawPackets, laneProcessed: [...laneProcessed] });
      for (let frame = 0; frame < warmupFrames + measuredFrames; frame++) {
        const elapsed = (frame + 1) * stepSeconds;
        const space = engine.getReceiverCapacity(state) - receiver.buffer;
        let amount;
        if (feed === 'saturated') amount = space;
        else {
          const nextOffered = Math.floor(elapsed * feed + 1e-8);
          externalBacklog += nextOffered - offered; offered = nextOffered;
          amount = Math.min(space, externalBacklog); externalBacklog -= amount;
        }
        receiver.buffer += amount; supplied += amount; maxReceiver = Math.max(maxReceiver, receiver.buffer);
        const nextId = state.nextId, jobs = testers.map(tester => tester.processing);
        engine.updateGame(state, stepSeconds, idle);
        for (let lane = 0; lane < testers.length; lane++) if (jobs[lane] && testers[lane].processing !== jobs[lane]) laneProcessed[lane] += jobs[lane].units;
        for (const capsule of state.capsules) if (capsule.id >= nextId && capsule.gx === receiver.gx && capsule.gy === receiver.gy) {
          rawPackets++; rawPacketUnits += capsule.units;
          if (capsule.units > LOGISTICS.capsuleUnits) largeRawPackets++;
        }
        if (firstTestSeconds === null && state.stats.testsSold > startingTests) firstTestSeconds = elapsed;
        if (observedGrossPaybackSeconds === null && state.earned - startingEarned >= cost) observedGrossPaybackSeconds = elapsed;
        if ((frame + 1) % 20 === 0) {
          assertFinite(state);
          if (held(state) + state.stats.delivered - startingSales !== supplied) throw Error('Network supplied material was lost or duplicated.');
          if (feed !== 'saturated' && offered !== supplied + externalBacklog) throw Error('External feed backlog accounting failed.');
          if (state.credits - startingCredits !== state.earned - startingEarned) throw Error('Fixture sale money ledger failed.');
          revenueTimeline.push(state.earned - startingEarned);
        }
        if (frame + 1 === warmupFrames) { warm = capture(); checkMass(state, qualificationInput + supplied); }
        if (frame + 1 === warmupFrames + Math.floor(measuredFrames / 2)) half = capture();
      }
      warm ??= { tests: startingTests, earned: startingEarned, accepted: 0, offered: 0, externalBacklog: 0, pending: 0, rawPacketUnits: 0, rawPackets: 0, largeRawPackets: 0, laneProcessed: Array(lanes).fill(0) };
      checkMass(state, qualificationInput + supplied);
      if (state.stats.rawSold !== startingRaw || state.stats.reportsSold !== startingReports) throw Error('Shared-input network leaked unprocessed material into a sale terminal.');
      const testsPerSecond = (state.stats.testsSold - warm.tests) / measuredSeconds;
      const creditsPerMinute = (state.earned - warm.earned) / measuredSeconds * 60;
      const firstHalfSeconds = Math.floor(measuredFrames / 2) * stepSeconds, secondHalfSeconds = measuredSeconds - firstHalfSeconds;
      const firstHalf = (half.tests - warm.tests) / firstHalfSeconds, secondHalf = (state.stats.testsSold - half.tests) / secondHalfSeconds;
      const variation = Math.abs(firstHalf - secondHalf) / Math.max(1, testsPerSecond) * 100;
      const finalQueues = queues(state);
      if (state.stats.testsSold - warm.tests + finalQueues.total - warm.pending !== supplied - warm.accepted) throw Error('Measured throughput does not match accepted input plus inventory change.');
      const key = `${length}:${feed}:${lanes}`;
      timelines.set(key, revenueTimeline);
      const row = { length, lanes, feedRawPerSecond: feed, fixture: fixtureDescription, qualificationInputRaw: qualificationInput,
        simulatedSeconds: round(state.time - startTime), stepSeconds, warmupSeconds, measuredSeconds, wallMilliseconds: Math.round(performance.now() - wallStarted),
        requestedReceiverDistance: remoteDistance, actualReceiverDistanceFromHub: round(distance(position(receiver), HUB)), rawTrunkCells: layout.rawTrunk.length, terminalPorts, componentCounts,
        plantCost: cost, suppliedFixtureRaw: supplied, offeredFixtureRaw: feed === 'saturated' ? null : offered, measuredAcceptedRaw: supplied - warm.accepted,
        measuredOfferedRaw: feed === 'saturated' ? null : offered - warm.offered, measuredTestsSold: state.stats.testsSold - warm.tests,
        testsPerSecond: round(testsPerSecond), creditsPerMinute: round(creditsPerMinute), addedValueOverRawPerMinute: round(testsPerSecond * (MATERIALS.test.value - MATERIALS.raw.value) * 60),
        firstTestSeconds: round(firstTestSeconds ?? 0), grossPlantPaybackObservedSeconds: observedGrossPaybackSeconds === null ? null : round(observedGrossPaybackSeconds),
        grossCostEquivalentSecondsAtSteadyRate: creditsPerMinute > 0 ? round(cost / creditsPerMinute * 60) : null,
        measuredPendingDelta: finalQueues.total - warm.pending, pending: finalQueues, externalBacklog, measuredExternalBacklogDelta: externalBacklog - warm.externalBacklog, maxReceiverBuffer: maxReceiver,
        meanRawCapsuleUnits: rawPackets > warm.rawPackets ? round((rawPacketUnits - warm.rawPacketUnits) / (rawPackets - warm.rawPackets)) : null,
        largeRawCapsulePercent: rawPackets > warm.rawPackets ? round((largeRawPackets - warm.largeRawPackets) / (rawPackets - warm.rawPackets) * 100) : 0,
        processedPerLanePerSecond: laneProcessed.map((value, index) => round((value - warm.laneProcessed[index]) / measuredSeconds)),
        stability: { firstHalfTestsPerSecond: round(firstHalf), secondHalfTestsPerSecond: round(secondHalf), variationPercent: round(variation), stableWithinTwoPercent: variation <= 2 },
        conservationPassed: true, moneyLedgerPassed: true };
      summaries.push(row);
      if (args.debug === 'true') console.error(JSON.stringify({ network: key, testsPerSecond: row.testsPerSecond, queues: row.pending.total, externalBacklog }));
    }
    const incremental = [];
    for (const [length] of definitions) for (const feed of ['saturated', 24, 60, 120]) for (const [from, to] of [[1, 2], [2, 4], [1, 4]]) {
      const a = summaries.find(row => row.length === length && row.feedRawPerSecond === feed && row.lanes === from);
      const b = summaries.find(row => row.length === length && row.feedRawPerSecond === feed && row.lanes === to);
      const extraCost = b.plantCost - a.plantCost, extraGrossPerMinute = b.creditsPerMinute - a.creditsPerMinute;
      const packetResolutionUnits = to * LOGISTICS.capsuleUnits * 2;
      const meaningfulGain = b.measuredTestsSold - a.measuredTestsSold > packetResolutionUnits;
      const before = timelines.get(`${length}:${feed}:${from}`), after = timelines.get(`${length}:${feed}:${to}`);
      const repaidAt = after.findIndex((revenue, index) => revenue - (before[index] ?? 0) >= extraCost);
      incremental.push({ length, feedRawPerSecond: feed, fromLanes: from, toLanes: to, incrementalCost: extraCost,
        addedTestsPerSecond: round(b.testsPerSecond - a.testsPerSecond), addedGrossCreditsPerMinute: round(extraGrossPerMinute),
        gainExceedsPacketResolution: meaningfulGain, packetResolutionUnits,
        throughputMultiplier: a.testsPerSecond > 0 ? round(b.testsPerSecond / a.testsPerSecond) : null,
        grossIncrementalPaybackObservedSeconds: meaningfulGain && repaidAt >= 0 ? repaidAt : null,
        grossIncrementalCostEquivalentSecondsAtSteadyRate: meaningfulGain && extraGrossPerMinute > 0 ? round(extraCost / extraGrossPerMinute * 60) : null });
    }
    for (const [length, remoteDistance] of definitions) for (const lanes of [1, 2, 4]) {
      const { state, receiver, qualificationInput, cost } = prepare(lanes, remoteDistance);
      const input = 600, initialTests = state.stats.testsSold, initialEarned = state.earned, started = state.time;
      receiver.buffer += input;
      while (held(state) > 0) {
        engine.updateGame(state, stepSeconds, idle);
        if (state.time - started > 600) throw Error('Finite network batch did not drain.');
      }
      checkMass(state, qualificationInput + input);
      if (state.stats.testsSold - initialTests !== input || state.earned - initialEarned !== input * MATERIALS.test.value) throw Error('More lanes created money or material from the same finite batch.');
      finiteBatch.push({ length, lanes, rawInput: input, soldTests: state.stats.testsSold - initialTests, revenue: state.earned - initialEarned, drainSeconds: round(state.time - started), plantCost: cost, conservationPassed: true });
    }
    const lengths = summaries.filter(row => row.length === 'long').map(long => {
      const short = summaries.find(row => row.length === 'short' && row.lanes === long.lanes && row.feedRawPerSecond === long.feedRawPerSecond);
      return { lanes: long.lanes, feedRawPerSecond: long.feedRawPerSecond, shortTestsPerSecond: short.testsPerSecond, longTestsPerSecond: long.testsPerSecond,
        extraBeltCost: long.plantCost - short.plantCost, extraFirstTestLatencySeconds: round(long.firstTestSeconds - short.firstTestSeconds),
        rateDifferencePercent: short.testsPerSecond ? round((long.testsPerSecond - short.testsPerSecond) / short.testsPerSecond * 100) : null };
    });
    const transportControls = [];
    for (const [length, remoteDistance] of definitions) {
      const { state, receiver, qualificationInput, layout } = prepare(1, remoteDistance, true);
      const initialRaw = state.stats.rawSold, initialReports = state.stats.reportsSold, initialTests = state.stats.testsSold;
      let supplied = 0, warmRaw = initialRaw, firstRawSeconds = null;
      for (let frame = 0; frame < warmupFrames + measuredFrames; frame++) {
        const amount = engine.getReceiverCapacity(state) - receiver.buffer;
        receiver.buffer += amount; supplied += amount;
        engine.updateGame(state, stepSeconds, idle);
        if (firstRawSeconds === null && state.stats.rawSold > initialRaw) firstRawSeconds = (frame + 1) * stepSeconds;
        if (frame + 1 === warmupFrames) warmRaw = state.stats.rawSold;
      }
      checkMass(state, qualificationInput + supplied);
      if (state.stats.reportsSold !== initialReports || state.stats.testsSold !== initialTests) throw Error('Transport-only control unexpectedly processed material.');
      transportControls.push({ length, fixture: 'Explicit transport-only control: same single receiver/raw trunk and one finished route, but both processors replaced by belts. Measures raw transport, not factory revenue.', rawTrunkCells: layout.rawTrunk.length,
        measuredRawSoldPerSecond: round((state.stats.rawSold - warmRaw) / measuredSeconds), firstRawSeconds: round(firstRawSeconds ?? 0), suppliedFixtureRaw: supplied, pending: held(state), conservationPassed: true });
    }
    const bottlenecks = definitions.map(([length]) => {
      const ceiling = summaries.find(row => row.length === length && row.feedRawPerSecond === 'saturated' && row.lanes === 4);
      const transport = transportControls.find(row => row.length === length);
      if (ceiling.testsPerSecond > transport.measuredRawSoldPerSecond * 1.02) throw Error('Reported factory flow exceeds its independently measured input transport.');
      return { length, transportOnlyRawPerSecond: transport.measuredRawSoldPerSecond, saturatedFourLaneTestsPerSecond: ceiling.testsPerSecond,
        feed24FourLaneTestsPerSecond: summaries.find(row => row.length === length && row.feedRawPerSecond === 24 && row.lanes === 4).testsPerSecond,
        feed60FourLaneTestsPerSecond: summaries.find(row => row.length === length && row.feedRawPerSecond === 60 && row.lanes === 4).testsPerSecond,
        interpretation: '24/60 supply limits actual output below the saturated plant. At120/s, processing and finite admission constrain the plant; the independently measured raw-only trunk carries more than the four-lane factory sells.' };
    });
    return { fixture: fixtureDescription, assumptions: [
      'Every 1/2/4-lane comparison uses the same single receiver, common raw trunk and component prices. Finished products have independent terminal ports; no raw/report shortcut sales are allowed.',
      '300s warmup and 600s measurement are defaults. Custom windows are reported explicitly, with first/second-half stability checks. Rates use actual sold tests, not recipes or completed jobs.',
      'Finite-rate supply retains unaccepted raw outside the game in an explicitly counted external backlog. Saturation refills the finite receiver; it is an injected ceiling fixture, not player income.',
      'Longer belts add cost, first-sale latency and material in transit. They do not increase the transfer speed of a belt; long/short rates are reported separately.',
      'Payback is gross production revenue excluding travel, gathering, construction time and input opportunity cost. Observed timestamps start with input supply; steady-rate cost equivalents are not human completion estimates.',
      'Incremental payback is omitted when the measured gain fits within two product packets per destination lane; endpoint packet timing is not an economic benefit. Observed incremental timestamps have one-second resolution.',
    ], config: { stepSeconds, warmupSeconds, measuredSeconds, paybackSampleSeconds: 1, fixtureFinancingCredits: 1e9, logistics: LOGISTICS, processing: PROCESSING, prices: BUILDINGS, nominalReceiverRawPerSecond: (LOGISTICS.rawCapsuleUnits ?? LOGISTICS.capsuleUnits) / LOGISTICS.emissionInterval,
      nominalTesterPerLanePerSecond: PROCESSING.tester.batch / PROCESSING.tester.cycle }, cases: summaries, incremental, lengthComparisons: lengths, transportControls, bottlenecks, finiteBatch };
  }

  function printSharedNetwork(network) {
    console.log('\nOne receiver → common raw trunk → independent 1/2/4 processing lanes');
    console.log(network.fixture);
    for (const assumption of network.assumptions) console.log(`- ${assumption}`);
    console.table(network.cases.map(row => ({ length: row.length, lanes: row.lanes, rawPerSecond: row.feedRawPerSecond, cost: row.plantCost, testsPerSecond: row.testsPerSecond, creditsPerMinute: row.creditsPerMinute, pending: row.pending.total, outsideBacklog: row.externalBacklog, firstTestSeconds: row.firstTestSeconds, stable: row.stability.stableWithinTwoPercent })));
    console.log('Incremental investment (gross, input and building travel excluded)');
    console.table(network.incremental.filter(row => row.toLanes === 4).map(row => ({ length: row.length, rawPerSecond: row.feedRawPerSecond, from: row.fromLanes, to: row.toLanes, extraCost: row.incrementalCost, addedTestsPerSecond: row.addedTestsPerSecond, extraCreditsPerMinute: row.addedGrossCreditsPerMinute, observedPaybackSeconds: row.grossIncrementalPaybackObservedSeconds })));
    console.log('Same finite 600 raw, no multiplication'); console.table(network.finiteBatch);
    console.log('Long/short transport comparison'); console.table(network.lengthComparisons);
    console.log('Separate transport-only and supply-limited controls'); console.table(network.bottlenecks);
  }

  if (mode === 'network') {
    const network = sharedInputComparisons();
    if (jsonOutput) console.log(JSON.stringify(network, null, 2)); else printSharedNetwork(network);
  } else {
    const result = {
      assumptions: [
        'Fresh deterministic world; actual engine movement, dust layers, bag capacity, processing jobs, prices, and purchase checks.',
        'Player replay is a deterministic automated controller with perfect dust knowledge and instant menus/building. Foot movement aims brushes; vehicle movement steers, accelerates, reverses out of stalls, and cleans only through the engine front rectangle at cleaning speed. Times describe this policy, not predicted human playtime.',
        'Navigation assumes the current 8px player collision radius; engine collisions remain authoritative and detected stalls fail the benchmark. The browser developed-start generator uses this same shared replay and pilot.',
        'Saturated factory fixtures inject disclosed raw input into finite receivers. They measure machinery ceilings, not achievable player earnings.',
        'Small/PRO robot fixtures finance equipment and qualify gates with disclosed injected factory raw. They then collect real generated dust globally, using physical small-robot returns or PRO remote transfer into finite connected receivers. Profiles compare one versus three factory lines and one versus five PRO robots over fifteen simulated minutes; the final ten minutes measure sustained collection and sales. Fixture building placement excludes travel time.',
        'Gather/return metrics use actual simulation time. Station visits are physical visits; unload actions can repeat during finite-buffer backpressure. The handbrush profile funds only its purchase and really collects 3,000 bugs before its measurement window.',
        `The progression policy buys handbrush, analysis line, capacityI, small robot, compact sweeper, broom, capacityII, speedI, ${parallelFactories === 2 ? 'second analysis line, ' : ''}tester(s), widebrush, heavy vehicle, PRO robot, remaining personal upgrades. All purchases require actual travel to the appropriate station. Machines have intervening belts; --parallel=2 builds and feeds two initial independent factory lines. --layout=network uses the same four-branch industrial planner and frontier receivers as the browser developed start; its extra PRO purchase follows the shared replay policy. Every actual purchase and demolition is audited at each replay step.`,
      ],
      config: { seed, maxReplayMinutes: maxSeconds / 60, parallelFactories, layoutStrategy, freshStructures: fresh.buildings.map(building => building.kind), economy: ECONOMY, tools: TOOLS, buildings: BUILDINGS, processing: PROCESSING, logistics:LOGISTICS, materials: MATERIALS, capacityPrices, speedPrices, vehicles:VEHICLES,robots:ROBOTS,maxRobots:ECONOMY.maxRobots },
      resourceBudget: { dirt: fresh.totalDirt, rawMaximum: fresh.totalDirt * MATERIALS.raw.value, reportMaximum: fresh.totalDirt * MATERIALS.report.value, testMaximum: fresh.totalDirt * MATERIALS.test.value, equipmentCost, proFleetPrices, maximumFleetEquipmentCost, analysisLineCost: analysisLayout.reduce((sum, [kind]) => sum + BUILDINGS[kind].price, 0), factoryAdditionalTesterCost: BUILDINGS.tester.price - Math.floor(BUILDINGS.belt.price / 2), plannedNetPurchaseCost: layoutStrategy === 'network' ? null : equipmentCost + parallelFactories * (analysisLayout.reduce((sum, [kind]) => sum + BUILDINGS[kind].price, 0) + BUILDINGS.tester.price - Math.floor(BUILDINGS.belt.price / 2)) },
      baseline: [], gatheringProfiles: [], factoryCeilings: [], robots: [], recovery: null, progression: null, sharedNetwork: null,
    };

    if (mode === 'all') {
      const baselineState = engine.createGame(seed);
      const baselinePilot = pilot(baselineState, uplink(baselineState));
      let first1000 = null;
      for (const checkpoint of [300, 600]) {
        while (baselineState.time < checkpoint) {
          drive(baselinePilot);
          if (!first1000 && baselineState.cleaned >= 1000) first1000 = { profile: 'starter toothbrush · first 1,000 bugs gathered', capacity: engine.getCapacity(baselineState), ...snapshot(baselineState), ...metricsSnapshot(baselinePilot) };
        }
        checkMass(baselineState);
        result.baseline.push({ ...snapshot(baselineState), capacity: engine.getCapacity(baselineState), creditsPerMinute: round(baselineState.earned / baselineState.time * 60), discoveries: baselineState.discoveries.length, ...metricsSnapshot(baselinePilot) });
      }
      if (first1000) result.gatheringProfiles.push(first1000);
      const handbrushState = engine.createGame(seed);
      handbrushState.credits = engine.upgradePrice(handbrushState, 'handbrush');
      const boughtHandbrush = fixturePurchase(handbrushState, 'handbrush');
      if (!boughtHandbrush.ok) throw Error(`Gathering fixture could not purchase handbrush: ${boughtHandbrush.message}`);
      const handbrushPilot = pilot(handbrushState, uplink(handbrushState));
      while (handbrushState.cleaned < 3000) drive(handbrushPilot);
      const handbrushStart = snapshot(handbrushState);
      const handbrushMetrics = metricsSnapshot(handbrushPilot);
      while (handbrushState.time - handbrushStart.seconds < 300) drive(handbrushPilot);
      checkMass(handbrushState);
      result.gatheringProfiles.push({ profile: 'handbrush · 300s after genuinely gathering 3,000 bugs', preparationSeconds: handbrushStart.seconds, startingCollected: handbrushStart.collected, startingBag: handbrushStart.playerBag, endingBag: handbrushState.player.bag, capacity: engine.getCapacity(handbrushState), measuredSeconds: round(handbrushState.time - handbrushStart.seconds), gathered: handbrushState.cleaned - handbrushStart.collected, sold: handbrushState.stats.delivered - handbrushStart.sold, ...metricsSnapshot(handbrushPilot, handbrushMetrics) });

      for (const stages of [1, 2]) {
        const { state, receiver, qualificationInput } = fixtureFactory(stages);
        const startTime = state.time;
        let supplied = 0;
        let warmupSales = 0;
        let warmupCredits = 0;
        for (let frame = 0; frame < 1800; frame++) {
          const amount = (engine.getReceiverCapacity?.(state) ?? RECEIVER_CAPACITY) - receiver.buffer;
          supplied += amount;
          receiver.buffer += amount;
          engine.updateGame(state, DT, idle);
          if (frame === 599) { warmupSales = state.stats.delivered; warmupCredits = state.earned; }
        }
        checkMass(state, supplied + qualificationInput);
        result.factoryCeilings.push({ stages, simulatedSeconds: round(state.time - startTime), measuredWindowSeconds: 120, suppliedFixtureRaw: supplied, qualificationInput, unitsPerMinute: round((state.stats.delivered - warmupSales) / 2), creditsPerMinute: round((state.earned - warmupCredits) / 2) });
      }

      function robotFixture(kind, count, lines) {
        const { state, receiver, qualificationInput } = fixtureFactory(2);
        const fixtureInput = qualificationInput + feedUntilSold(state, receiver, Math.max(ECONOMY.vehicleTests, ECONOMY.robotTests));
        state.credits = 1e9;
        for (let level = 0; level < 2; level++) {
          const bought = fixturePurchase(state, 'capacity'); if (!bought.ok) throw Error(bought.message);
        }
        const rover = fixturePurchase(state, 'vehicle'); if (!rover.ok) throw Error(rover.message);
        if (lines >= 2) fixturePlace(state, secondLayout.map((node,index)=>index===4?['tester',...node.slice(1)]:node));
        if (lines >= 3) {
          const gx=Math.floor(TERMINALS[2].x/BUILD_CELL), gy=Math.floor(TERMINALS[2].y/BUILD_CELL);
          fixturePlace(state,[['belt',gx+1,gy,0],['belt',gx+2,gy,0],['tester',gx+3,gy,0],['belt',gx+4,gy,0],['belt',gx+5,gy,0],['analyzer',gx+6,gy,0],['belt',gx+7,gy,0],['belt',gx+8,gy,0],['receiver',gx+9,gy,0]]);
        }
        const before=state.credits;
        for(let index=0;index<count;index++) {
          const bought=fixturePurchase(state,kind); if(!bought.ok)throw Error(bought.message);
        }
        return {state,fixtureInput,robotPurchaseCost:before-state.credits};
      }
      for (const [kind,count,lines] of [['robot',1,1],['industrialRobot',1,1],['industrialRobot',1,3],['industrialRobot',5,1],['industrialRobot',5,3]]) {
        const {state,fixtureInput,robotPurchaseCost}=robotFixture(kind,count,lines);
        const initial=snapshot(state), started=state.time, wallStarted=performance.now();
        let warmup=null, blockedSeconds=0, maxBuffer=0, maxBag=0;
        for(let frame=0;frame<9000;frame++) {
          engine.updateGame(state,DT,idle);
          const receivers=engine.getRobotReceivers(state);
          if(!engine.getRobotReceivers(state,true).length)blockedSeconds+=DT;
          for(const receiver of receivers) {
            maxBuffer=Math.max(maxBuffer,receiver.buffer);
            if(receiver.buffer>engine.getReceiverCapacity(state))throw Error('Global robot overfilled a finite receiver.');
          }
          for(const robot of state.robots) {
            maxBag=Math.max(maxBag,robot.bag);
            if(robot.bag>robot.capacity)throw Error('Global robot overfilled its own cargo.');
          }
          if(frame===2999)warmup=snapshot(state);
        }
        checkMass(state,fixtureInput);
        let farthestTrack=0;
        for(let index=0;index<state.dust.length;index++)if(state.dust[index]<fresh.dust[index])farthestTrack=Math.max(farthestTrack,distance({x:index%GRID_W*CELL+CELL/2,y:Math.floor(index/GRID_W)*CELL+CELL/2},HUB));
        const measuredMinutes=(state.time-warmup.seconds)/60;
        const soldPerMinute=(state.stats.testsSold-warmup.testsSold)/measuredMinutes;
        const earnedPerMinute=(state.earned-warmup.earned)/measuredMinutes;
        if(kind==='industrialRobot' && farthestTrack<600)throw Error('PRO did not collect beyond the old local receiver radius.');
        if(count===5 && lines===1 && blockedSeconds===0)throw Error('Five PRO robots did not exercise finite receiver backpressure.');
        result.robots.push({kind,count,lines,fixture:'Financed equipment; gate counters earned by disclosed injected qualification raw. Measurement collects only actual generated world dirt; stationary player.',simulatedSeconds:round(state.time-started),wallMilliseconds:Math.round(performance.now()-wallStarted),warmupSeconds:300,measuredSeconds:round(state.time-warmup.seconds),collected:state.cleaned-initial.collected,sold:state.stats.delivered-initial.sold,sustainedCollectedPerMinute:round((state.cleaned-warmup.collected)/measuredMinutes),sustainedTestsPerMinute:round(soldPerMinute),sustainedRevenuePerMinute:round(earnedPerMinute),robotPurchaseCost,observedPurchasePaybackMinutes:earnedPerMinute>0?round(robotPurchaseCost/earnedPerMinute):null,blockedByFullReceiversSeconds:round(blockedSeconds),receiverCapacity:engine.getReceiverCapacity(state),maxReceiverBuffer:maxBuffer,maxRobotBag:maxBag,farthestCleanedFromHub:round(farthestTrack),worldRemaining:state.totalDirt-state.cleaned,held:held(state)});
      }

      if (typeof engine.reclaimBugs === 'function') {
        const { state, receiver, qualificationInput } = fixtureFactory(2);
        if (engine.getCapacity(state) < (ECONOMY?.reclaimBatch ?? 64)) {
          const bought = fixturePurchase(state, 'capacity');
          if (!bought.ok) throw Error(`Recovery fixture capacity qualification: ${bought.message}`);
        }
        const units = Math.min(ECONOMY?.reclaimBatch ?? 64, engine.getCapacity(state));
        // Explicit injected fixture cargo is sold first through the real terminal.
        // Reclaim and reprocessing then receive no further material or cash subsidy.
        Object.assign(state.player, position(uplink(state)));
        state.player.bag = units;
        const originalSale = engine.interact(state);
        if (!originalSale.ok) throw Error(originalSale.message);
        const creditsBeforeReclaim = state.credits;
        const testsBeforeReclaim = state.stats.testsSold;
        const reclaim = engine.reclaimBugs(state);
        if (!reclaim.ok) throw Error(reclaim.message);
        const reclaimCost = creditsBeforeReclaim - state.credits;
        state.player.x = position(receiver).x;
        state.player.y = position(receiver).y;
        const deposit = engine.interact(state);
        if (!deposit.ok) throw Error(deposit.message);
        const startTime = state.time;
        while (state.stats.testsSold - testsBeforeReclaim < units) {
          engine.updateGame(state, DT, idle);
          if (state.time - startTime > 2000) throw Error('Recovered cargo did not reach the sale terminal.');
        }
        checkMass(state, qualificationInput + units);
        const netProfit = state.credits - creditsBeforeReclaim;
        const emptyStock = engine.reclaimBugs(state);
        if (emptyStock.ok) throw Error('Recovery created reclaimable raw stock without a new raw sale.');
        result.recovery = { fixture: 'Financed factory; disclosed raw cargo sold through the actual terminal before recovery.', initiallySoldRaw: units, reclaimed: state.stats.rawReclaimed, reclaimCost, finishedTestsSold: state.stats.testsSold - testsBeforeReclaim, productRevenue: netProfit + reclaimCost, netIncrementalProfit: netProfit, processingSeconds: round(state.time - startTime), stockRemaining: state.stats.rawSold - state.stats.rawReclaimed, exhaustedStockRejects: !emptyStock.ok };
      }

    }

    const replay = createProgressionReplay(seed, { parallelFactories, layoutStrategy, maxSeconds, ...(layoutStrategy === 'network' ? { showcaseRobots: 2 } : {}), ...(mode === 'developed' ? { stopAtFirstPro: true, safeHandoff: true } : {}) });
    const progression = replay.state;
    const purchaseLedger = { tools: 0, capacity: 0, speed: 0, vehicles: 0, robots: 0, construction: 0, demolitionRefunds: 0, rawRecovery: 0 };
    function beforePurchases(state) {
      return { credits: state.credits, earned: state.earned, capacity: state.player.capacityLevel, speed: state.player.speedLevel,
        tools: new Set(state.ownedTools), vehicles: new Set(state.vehicles.map(vehicle => vehicle.kind)),
        robots: new Map(state.robots.map(robot => [robot.id, robot.kind])), buildings: new Map(state.buildings.map(building => [building.id, building])), rawReclaimed: state.stats.rawReclaimed };
    }
    function auditPurchases(before, state) {
      const changes = { tools: 0, capacity: 0, speed: 0, vehicles: 0, robots: 0, construction: 0, demolitionRefunds: 0, rawRecovery: 0 };
      for (const tool of state.ownedTools) if (!before.tools.has(tool)) changes.tools += TOOLS[tool].price;
      for (let level = before.capacity; level < state.player.capacityLevel; level++) changes.capacity += ECONOMY.capacity[level];
      for (let level = before.speed; level < state.player.speedLevel; level++) changes.speed += ECONOMY.speed[level];
      for (const vehicle of state.vehicles) if (!before.vehicles.has(vehicle.kind)) changes.vehicles += VEHICLES[vehicle.kind].price;
      for (const kind of Object.keys(ROBOTS)) {
        const countBefore = [...before.robots.values()].filter(value => value === kind).length;
        const purchased = state.robots.filter(robot => robot.kind === kind && before.robots.get(robot.id) !== kind).length;
        for (let index = 0; index < purchased; index++) changes.robots += Math.round(ROBOTS[kind].price * ECONOMY.robotPriceMultiplier ** (countBefore + index) / 100) * 100;
      }
      for (const building of state.buildings) if (!before.buildings.has(building.id)) changes.construction += BUILDINGS[building.kind]?.price ?? 0;
      const remaining = new Set(state.buildings.map(building => building.id));
      for (const [id, building] of before.buildings) if (!remaining.has(id) && building.kind !== 'uplink' && !building.starter) changes.demolitionRefunds += Math.floor(BUILDINGS[building.kind].price / 2);
      changes.rawRecovery = (state.stats.rawReclaimed - before.rawReclaimed) * ECONOMY.reclaimPrice;
      const net = Object.entries(changes).reduce((sum, [key, amount]) => sum + (key === 'demolitionRefunds' ? -amount : amount), 0);
      if (before.credits - state.credits + state.earned - before.earned !== net) throw Error(`Fresh purchase ledger failed at ${state.time}s toward ${replay.goal}.`);
      for (const key of Object.keys(changes)) purchaseLedger[key] += changes[key];
    }
    while (!replay.done) {
      if (args.debug === 'true' && replay.frames % 1000 === 0) console.error(JSON.stringify({ goal: replay.goal, frames: replay.frames, ...snapshot(progression) }));
      const purchasesBefore = beforePurchases(progression);
      replay.step();
      auditPurchases(purchasesBefore, progression);
    }
    checkMass(progression);
    const actualFactoryCost = purchaseLedger.construction - purchaseLedger.demolitionRefunds;
    const actualEquipmentCost = purchaseLedger.tools + purchaseLedger.capacity + purchaseLedger.speed + purchaseLedger.vehicles + purchaseLedger.robots;
    result.resourceBudget.actualFactoryNetPurchaseCost=actualFactoryCost;
    result.resourceBudget.actualEquipmentNetPurchaseCost=actualEquipmentCost;
    result.resourceBudget.actualCompleteProgressionNetCost=actualEquipmentCost+actualFactoryCost+purchaseLedger.rawRecovery;
    if(progression.earned-progression.credits!==result.resourceBudget.actualCompleteProgressionNetCost)throw Error('Fresh progression purchase ledger does not match actual owned equipment and construction.');
    result.progression = { milestones: replay.milestones, reachedAll: replay.done, stop: snapshot(progression), nextGoal: replay.goal, lastBlockedReason: replay.lastBlockedReason, remainingDust: progression.totalDirt - progression.cleaned, cleanedPercent: round(progression.cleaned / progression.totalDirt * 100), materialInBagsOrFactory: held(progression), netSpent: progression.earned - progression.credits, purchaseLedger, materialConservationPassed: true, moneyLedgerPassed: true, discoveries: progression.discoveries.length, discoveryCredits: progression.earned - progression.stats.rawSold * MATERIALS.raw.value - progression.stats.reportsSold * MATERIALS.report.value - progression.stats.testsSold * MATERIALS.test.value, ...replay.metricsSnapshot(), maximumSimulatedMinutes: maxSeconds / 60 };
    result.progression.finalNetwork = { analyzers: progression.buildings.filter(b => b.kind === 'analyzer').length, testers: progression.buildings.filter(b => b.kind === 'tester').length,
      receivers: progression.buildings.filter(b => b.kind === 'receiver').map(b => ({ gx: b.gx, gy: b.gy, distanceFromHub: round(distance(position(b), HUB)), connected: engine.receiverHasRoute(progression,b), buffer: b.buffer })),
      fleet: Object.fromEntries(Object.keys(ROBOTS).map(kind => [kind,progression.robots.filter(robot=>robot.kind===kind).length])) };
    result.progression.handoff = { onFoot: !progression.player.riding, playerBag: progression.player.bag, distanceFromSpawn: round(distance(progression.player,SPAWN)), maxParkedVehicleSpeed: Math.max(0,...progression.vehicles.map(vehicle=>Math.abs(vehicle.speed))) };

    if (mode === 'all') result.sharedNetwork = sharedInputComparisons();

    if (jsonOutput) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('PROD Sweepers · deterministic balance benchmark');
      for (const assumption of result.assumptions) console.log(`- ${assumption}`);
      console.log('\nProduction prices and resource budget');
      console.log(JSON.stringify({ config: result.config, resources: result.resourceBudget }, null, 2));
      console.log('\nFresh-world starter toothbrush → direct raw sale (no purchases)');
      console.table(result.baseline);
      console.log('\nActual navigation gather/return profiles');
      console.table(result.gatheringProfiles);
      console.log('\nSaturated factory ceiling · minute 2–3 measurement');
      console.table(result.factoryCeilings);
      console.log('\nGlobal robots · financed fixture, actual world dirt, finite receiver backpressure');
      console.table(result.robots);
      if (result.recovery) {
        console.log('\nRaw recovery fixture · actual purchase, processing, finite stock');
        console.log(JSON.stringify(result.recovery, null, 2));
      }
      if (result.sharedNetwork) printSharedNetwork(result.sharedNetwork);
      console.log('\nFresh-world autopilot progression · actual purchases, steering and physical station visits');
      console.table(result.progression.milestones.map(item => ({ milestone: item.id, minutes: round(item.seconds / 60), earned: item.earned, collected: item.collected, cashAfterPurchase: item.credits })));
      console.log(JSON.stringify({ ...result.progression, milestones: undefined }, null, 2));
    }
  }
} finally {
  await server.close();
}
