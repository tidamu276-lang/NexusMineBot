const mineflayer = require('mineflayer');
const { EventEmitter } = require('events');
const readline = require('readline');
const originalWarn = console.warn;

const { goals, loader: baritonePlugin } = require('@miner-org/mineflayer-baritone');
const movementMod = require('@miner-org/mineflayer-baritone/src/movement/index');
const { Vec3 } = require('vec3');

EventEmitter.defaultMaxListeners = 50;
if (process.stdin.setMaxListeners) process.stdin.setMaxListeners(50);
if (process.stdout.setMaxListeners) process.stdout.setMaxListeners(50);
if (process.stderr.setMaxListeners) process.stderr.setMaxListeners(50);

const WHITELIST = new Set([
  'your nickname',
]);

function isWhitelisted(username) {
  return WHITELIST.has(username);
}

function patchMovementSafety() {
  const classes = Object.values(movementMod).filter(
    (v) => typeof v === 'function' && v.prototype
  );
  
  const methodsToPatch = [
    'isFullBlock', 'isSolid', 'isStandable', 'isWalkable',
    'isSafe', 'isClimbable', 'isWater', 'isLava',
    'canWalkOn', 'canWalkThrough', 'isAir', 'isEmpty',
    'generate', 'getBlock', 'checkBlock'
  ];
  
  for (const cls of classes) {
    for (const methodName of methodsToPatch) {
      if (typeof cls.prototype[methodName] === 'function') {
        const orig = cls.prototype[methodName];
        cls.prototype[methodName] = function (...args) {
          try {
            for (const arg of args) {
              if (arg === null || arg === undefined) {
                return methodName.includes('is') ? false : null;
              }
            }
            return orig.call(this, ...args);
          } catch {
            return methodName.includes('is') ? false : null;
          }
        };
      }
    }
  }
}

function patchIsWalkable() {
  const classes = Object.values(movementMod).filter(
    (v) => typeof v === 'function' && v.prototype
  );
  
  for (const cls of classes) {
    if (typeof cls.prototype.isWalkable === 'function') {
      const orig = cls.prototype.isWalkable;
      cls.prototype.isWalkable = function (block, above, above2) {
        try {
          if (!block || !above) return false;
          if (above2 === null) above2 = { boundingBox: 'empty' };
          return orig.call(this, block, above, above2);
        } catch {
          return false;
        }
      };
    }
  }
}

function patchParkour() {
  try {
    const parkourModule = require('@miner-org/mineflayer-baritone/src/movement/basic-parkour');
    if (parkourModule) {
      const classes = Object.values(parkourModule).filter(
        (v) => typeof v === 'function' && v.prototype
      );
      for (const cls of classes) {
        if (typeof cls.prototype.generate === 'function') {
          const orig = cls.prototype.generate;
          cls.prototype.generate = function (...args) {
            try {
              return orig.call(this, ...args);
            } catch {
              return [];
            }
          };
        }
      }
    }
  } catch {}
}

patchMovementSafety();
patchIsWalkable();
patchParkour();

const TARGET_POS = { x: 1130, y: 68, z: -2476 };
const TARGET_TOLERANCE = 0.0;
const STUCK_CHECK_INTERVAL = 4000;
const MOVEMENT_CHECK_INTERVAL = 2000;
const MAX_STUCK_COUNT = 4;
const PATHING_STUCK_THRESHOLD = 6;

const COMBAT = {
  ATTACK_RANGE: 3.2,
  CHASE_RANGE: 16,
  THREAT_RANGE: 5,
  OPTIMAL_RANGE: 2.8,
  CRITICAL_RANGE: 1.5,
  
  WEAPON_COOLDOWNS: {
    'netherite_sword': 625,
    'diamond_sword': 625,
    'iron_sword': 625,
    'stone_sword': 625,
    'golden_sword': 625,
    'wooden_sword': 625,
    'netherite_axe': 1000,
    'diamond_axe': 1000,
    'iron_axe': 1100,
    'stone_axe': 1250,
    'wooden_axe': 1250,
    'golden_axe': 1000,
    'trident': 1100,
    'default': 625
  },
  
  ATTACK_COOLDOWN_BUFFER: 50,
  STRAFE_INTERVAL: 300,
  STRAFE_DURATION: 200,
  STRAFE_CHANCE: 0.6,
  WTAP_DURATION: 60,
  WTAP_CHANCE: 0.55,
  STAP_DURATION: 80,
  STAP_CHANCE: 0.3,
  CROUCH_CHANCE: 0.25,
  CROUCH_DURATION: 150,
  CROUCH_AFTER_HIT: 0.35,
  COMBO_SPRINT_RESET: 100,
  MAX_CHASE_TIME: 15000,
  HITS_TO_KILL: 25
};

let bot;
let mcData;
let stuckCheckInterval = null;
let movementCheckInterval = null;
let combatInterval = null;
let strafeInterval = null;
let pingInterval = null;

let state = {
  traveling: false,
  reachedTarget: false,
  isDead: false,
  isFirstSpawn: true,
  lastPosition: null,
  lastDistance: null,
  stuckCount: 0,
  pathingStuckCount: 0,
  lastMoveAttempt: 0,
  pathingInProgress: false,
  fullRestartInProgress: false,
  inCombat: false,
  combatTarget: null,
  lastAttackTime: 0,
  lastHitTime: 0,
  lastDamageTaken: 0,
  hitBy: null,
  hitByTime: 0,
  combatStartTime: 0,
  hitCount: 0,
  comboCount: 0,
  strafeDirection: 1,
  isCrouching: false,
  enemies: new Map(),
  currentWeaponCooldown: COMBAT.WEAPON_COOLDOWNS.default,
  lastHealth: 20,
  plateDefenseMode: false,
  isHandlingKicked: false,
  warpRetryInProgress: false,
  warpExitConfirmed: false,
  compassCooldownRetryInProgress: false
};

console.warn = (...args) => {
  const msg = args.join(" ");
  if (msg.includes("chunk failed to load")) return;
  originalWarn(...args);
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function getDistanceToTarget() {
  if (!bot?.entity?.position) return Infinity;
  const pos = bot.entity.position;
  const dx = pos.x - TARGET_POS.x;
  const dy = pos.y - TARGET_POS.y;
  const dz = pos.z - TARGET_POS.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getHorizontalDistance() {
  if (!bot?.entity?.position) return Infinity;
  const pos = bot.entity.position;
  const dx = pos.x - TARGET_POS.x;
  const dz = pos.z - TARGET_POS.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function isAtTarget() {
  return getHorizontalDistance() <= TARGET_TOLERANCE;
}

function isCurrentlyPathing() {
  try {
    return bot?.ashfinder?.isPathing === true;
  } catch {
    return false;
  }
}

function getWeaponCooldown() {
  try {
    const mainHand = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
    if (!mainHand) return COMBAT.WEAPON_COOLDOWNS.default;
    return COMBAT.WEAPON_COOLDOWNS[mainHand.name] || COMBAT.WEAPON_COOLDOWNS.default;
  } catch {
    return COMBAT.WEAPON_COOLDOWNS.default;
  }
}

function isAttackReady() {
  const now = Date.now();
  const cooldown = getWeaponCooldown() + COMBAT.ATTACK_COOLDOWN_BUFFER;
  return (now - state.lastAttackTime) >= cooldown;
}

function getNearestPlayer(maxDist = COMBAT.CHASE_RANGE) {
  const players = Object.values(bot.players).filter(p => {
    if (!p.entity) return false;
    if (p.username === bot.username) return false;
    if (isWhitelisted(p.username)) {
      return false;
    }
    const dist = bot.entity.position.distanceTo(p.entity.position);
    return dist <= maxDist;
  });
  
  if (players.length === 0) return null;
  
  players.sort((a, b) => {
    const distA = bot.entity.position.distanceTo(a.entity.position);
    const distB = bot.entity.position.distanceTo(b.entity.position);
    const enemyA = state.enemies.get(a.username);
    const enemyB = state.enemies.get(b.username);
    if (enemyA && !enemyB) return -1;
    if (!enemyA && enemyB) return 1;
    return distA - distB;
  });
  
  return players[0];
}

function getThreatsOnPlate() {
  return Object.values(bot.players).filter(p => {
    if (!p.entity) return false;
    if (p.username === bot.username) return false;
    if (isWhitelisted(p.username)) {
      return false;
    }
    const playerPos = p.entity.position;
    const dx = playerPos.x - TARGET_POS.x;
    const dz = playerPos.z - TARGET_POS.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    return dist <= COMBAT.THREAT_RANGE;
  });
}

async function smoothLookAt(entity) {
  if (!entity?.position) return;
  const targetPos = entity.position.offset(0, entity.height * 0.75, 0);
  if (entity.velocity) {
    const ticksPrediction = 3;
    targetPos.x += entity.velocity.x * ticksPrediction;
    targetPos.z += entity.velocity.z * ticksPrediction;
  }
  await bot.lookAt(targetPos, true);
}

async function doCrouch(duration = COMBAT.CROUCH_DURATION) {
  if (state.isCrouching) return;
  state.isCrouching = true;
  bot.setControlState('sneak', true);
  await delay(duration);
  bot.setControlState('sneak', false);
  state.isCrouching = false;
}

async function attack(target) {
  if (!target?.entity) return false;
  if (!isAttackReady()) return false;
  if (isWhitelisted(target.username)) {
    console.log(`[COMBAT] ${target.username} в whitelist, не атакую`);
    return false;
  }
  const dist = bot.entity.position.distanceTo(target.entity.position);
  if (dist > COMBAT.ATTACK_RANGE) return false;
  try {
    await smoothLookAt(target.entity);
    await bot.attack(target.entity);
    state.lastAttackTime = Date.now();
    state.hitCount++;
    state.comboCount++;
    console.log(`[COMBAT] Удар #${state.hitCount} (combo: ${state.comboCount})`);
    return true;
  } catch {
    return false;
  }
}

async function criticalAttack(target) {
  if (!target?.entity) return false;
  if (!isAttackReady()) return false;
  if (isWhitelisted(target.username)) return false;
  const dist = bot.entity.position.distanceTo(target.entity.position);
  if (dist > COMBAT.ATTACK_RANGE) return false;
  try {
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      await delay(50);
      bot.setControlState('jump', false);
      await delay(150);
    }
    let waitTime = 0;
    while (bot.entity.velocity.y > -0.08 && waitTime < 250) {
      await delay(10);
      waitTime += 10;
    }
    await smoothLookAt(target.entity);
    await bot.attack(target.entity);
    state.lastAttackTime = Date.now();
    state.hitCount++;
    state.comboCount++;
    console.log(`[COMBAT] КРИТ #${state.hitCount}! `);
    return true;
  } catch {
    return false;
  }
}

async function wtapAttack(target) {
  if (!target?.entity) return false;
  if (!isAttackReady()) return false;
  if (isWhitelisted(target.username)) return false;
  try {
    await smoothLookAt(target.entity);
    if (Math.random() < COMBAT.WTAP_CHANCE) {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      await delay(COMBAT.WTAP_DURATION);
    }
    await bot.attack(target.entity);
    state.lastAttackTime = Date.now();
    state.hitCount++;
    state.comboCount++;
    await delay(30);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    console.log(`[COMBAT] W-tap #${state.hitCount}`);
    return true;
  } catch {
    return false;
  }
}

async function stapAttack(target) {
  if (!target?.entity) return false;
  if (!isAttackReady()) return false;
  if (isWhitelisted(target.username)) return false;
  try {
    await smoothLookAt(target.entity);
    await bot.attack(target.entity);
    state.lastAttackTime = Date.now();
    state.hitCount++;
    state.comboCount++;
    if (Math.random() < COMBAT.STAP_CHANCE) {
      bot.setControlState('forward', false);
      bot.setControlState('back', true);
      await delay(COMBAT.STAP_DURATION);
      bot.setControlState('back', false);
      bot.setControlState('forward', true);
    }
    console.log(`[COMBAT] S-tap #${state.hitCount}`);
    return true;
  } catch {
    return false;
  }
}

async function comboAttack(target) {
  if (!target?.entity) return false;
  if (!isAttackReady()) return false;
  if (isWhitelisted(target.username)) {
    console.log(`[COMBAT] ${target.username} в whitelist, прекращаю бой`);
    stopCombat();
    return false;
  }
  const dist = bot.entity.position.distanceTo(target.entity.position);
  if (dist > COMBAT.ATTACK_RANGE) return false;
  const roll = Math.random();
  const comboMod = state.comboCount % 4;
  if (comboMod === 3 && bot.entity.onGround) {
    return await criticalAttack(target);
  }
  if (roll < 0.15) {
    await doCrouch(80);
  }
  if (roll < 0.35) {
    return await wtapAttack(target);
  } else if (roll < 0.55) {
    return await stapAttack(target);
  } else if (roll < 0.75 && bot.entity.onGround) {
    return await criticalAttack(target);
  } else {
    return await attack(target);
  }
}

function startStrafe() {
  if (strafeInterval) return;
  strafeInterval = setInterval(() => {
    if (!state.inCombat || !state.combatTarget?.entity) {
      stopStrafe();
      return;
    }
    if (Math.random() < 0.3) {
      state.strafeDirection *= -1;
    }
    if (Math.random() < COMBAT.STRAFE_CHANCE) {
      bot.setControlState('left', state.strafeDirection < 0);
      bot.setControlState('right', state.strafeDirection > 0);
      if (Math.random() < 0.15) {
        doCrouch(100);
      }
      setTimeout(() => {
        bot.setControlState('left', false);
        bot.setControlState('right', false);
      }, COMBAT.STRAFE_DURATION);
    }
  }, COMBAT.STRAFE_INTERVAL);
}

function stopStrafe() {
  if (strafeInterval) {
    clearInterval(strafeInterval);
    strafeInterval = null;
  }
  try {
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    bot.setControlState('sneak', false);
    state.isCrouching = false;
  } catch {}
}

async function chaseTarget(target) {
  if (!target?.entity) return;
  const dist = bot.entity.position.distanceTo(target.entity.position);
  await smoothLookAt(target.entity);
  if (dist > COMBAT.OPTIMAL_RANGE + 0.5) {
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('back', false);
    if (bot.entity.onGround && Math.random() < 0.2) {
      bot.setControlState('jump', true);
      await delay(50);
      bot.setControlState('jump', false);
    }
  } else if (dist < COMBAT.CRITICAL_RANGE) {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('back', true);
    if (Math.random() < 0.2) {
      await doCrouch(100);
    }
  } else {
    bot.setControlState('forward', false);
    bot.setControlState('back', false);
    bot.setControlState('sprint', true);
  }
}

async function equipBestWeapon() {
  const weapons = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'
  ];
  const items = bot.inventory.items();
  for (const weaponName of weapons) {
    const weapon = items.find(item => item.name === weaponName);
    if (weapon) {
      try {
        await bot.equip(weapon, 'hand');
        state.currentWeaponCooldown = getWeaponCooldown();
        console.log(`[COMBAT] Оружие: ${weapon.name}`);
        return true;
      } catch {}
    }
  }
  return false;
}

async function equipShield() {
  const shield = bot.inventory.items().find(item => item.name.includes('shield'));
  if (shield) {
    try {
      await bot.equip(shield, 'off-hand');
      return true;
    } catch {}
  }
  return false;
}

async function startCombat(target, reason = 'threat') {
  if (!target?.entity) return;
  if (isWhitelisted(target.username)) {
    console.log(`[COMBAT] ${target.username} в whitelist, не начинаю бой`);
    return;
  }
  if (state.inCombat && state.combatTarget?.username === target.username) return;
  console.log(`[COMBAT] === БОЙ с ${target.username} (${reason}) ===`);
  await forceStopPathfinder();
  state.inCombat = true;
  state.combatTarget = target;
  state.combatStartTime = Date.now();
  state.hitCount = 0;
  state.comboCount = 0;
  state.lastAttackTime = 0;
  state.enemies.set(target.username, {
    lastHit: Date.now(),
    threatLevel: reason === 'revenge' ? 10 : 5
  });
  await equipBestWeapon();
  await equipShield();
  startStrafe();
  startCombatLoop();
}

function startCombatLoop() {
  if (combatInterval) clearInterval(combatInterval);
  combatInterval = setInterval(async () => {
    if (!state.inCombat || state.isDead) {
      stopCombat();
      return;
    }
    const target = state.combatTarget;
    if (target && isWhitelisted(target.username)) {
      console.log(`[COMBAT] ${target.username} в whitelist, прекращаю бой`);
      stopCombat();
      return;
    }
    if (!target?.entity) {
      const newTarget = getNearestPlayer(COMBAT.CHASE_RANGE);
      if (newTarget) {
        state.combatTarget = newTarget;
        state.comboCount = 0;
        console.log(`[COMBAT] Новая цель: ${newTarget.username}`);
      } else {
        stopCombat();
      }
      return;
    }
    const dist = bot.entity.position.distanceTo(target.entity.position);
    const combatDuration = Date.now() - state.combatStartTime;
    if (combatDuration > COMBAT.MAX_CHASE_TIME || state.hitCount > COMBAT.HITS_TO_KILL) {
      console.log('[COMBAT] Таймаут боя');
      stopCombat();
      return;
    }
    if (dist > COMBAT.CHASE_RANGE) {
      console.log('[COMBAT] Цель убежала');
      stopCombat();
      return;
    }
    await chaseTarget(target);
    if (dist <= COMBAT.ATTACK_RANGE && isAttackReady()) {
      await comboAttack(target);
    }
  }, 50);
}

function stopCombat() {
  console.log('[COMBAT] === КОНЕЦ БОЯ ===');
  state.inCombat = false;
  state.combatTarget = null;
  state.comboCount = 0;
  if (combatInterval) {
    clearInterval(combatInterval);
    combatInterval = null;
  }
  stopStrafe();
  try {
    bot.clearControlStates();
  } catch {}
  if (state.reachedTarget || isAtTarget()) {
    state.plateDefenseMode = true;
  } else {
    setTimeout(() => walkToTarget(), 1000);
  }
}

function onDamageTaken(attacker) {
  if (!attacker || attacker.username === bot.username) return;
  if (isWhitelisted(attacker.username)) {
    console.log(`[COMBAT] ${attacker.username} в whitelist, игнорирую удар`);
    return;
  }
  console.log(`[COMBAT] Удар от ${attacker.username}!`);
  state.hitBy = attacker;
  state.hitByTime = Date.now();
  state.lastDamageTaken = Date.now();
  state.comboCount = 0;
  const enemy = state.enemies.get(attacker.username) || { threatLevel: 0 };
  enemy.lastHit = Date.now();
  enemy.threatLevel = Math.min(enemy.threatLevel + 3, 15);
  state.enemies.set(attacker.username, enemy);
  if (Math.random() < COMBAT.CROUCH_AFTER_HIT) {
    doCrouch(randInt(100, 180));
  }
  if (!state.inCombat) {
    const targetPlayer = bot.players[attacker.username];
    if (targetPlayer?.entity) {
      startCombat(targetPlayer, 'revenge');
    }
  }
}

function checkPlateThreats() {
  if (!state.reachedTarget && !isAtTarget()) return;
  if (state.inCombat) return;
  const threats = getThreatsOnPlate();
  if (threats.length > 0) {
    const threat = threats[0];
    console.log(`[COMBAT] Угроза на плите: ${threat.username}`);
    startCombat(threat, 'plate_defense');
  }
}

async function handleKickedMessage() {
  if (state.isHandlingKicked) return;
  state.isHandlingKicked = true;
  console.log('[KICKED] Обнаружено сообщение о кике! Перезапуск...');
  try {
    if (state.inCombat) stopCombat();
    await forceStopPathfinder();
    await delay(1500);
    console.log('[KICKED] Использую компас...');
    await useCompass();
    await delay(500);
    await sendWarpExit();
    await delay(3000);
    state.traveling = false;
    state.pathingInProgress = false;
    state.reachedTarget = false;
    state.stuckCount = 0;
    state.pathingStuckCount = 0;
    if (bot?.entity?.position) {
      state.lastDistance = getDistanceToTarget();
      state.lastPosition = bot.entity.position.clone();
    }
    if (!movementCheckInterval) startMovementMonitor();
    if (!stuckCheckInterval) startStuckCheck();
    await delay(500);
    await walkToTarget();
  } catch (err) {
    console.error('[KICKED] Ошибка:', err.message);
  } finally {
    state.isHandlingKicked = false;
  }
}

function setupPathfinder() {
  if (!bot.ashfinder?.config) return;
  const cfg = bot.ashfinder.config;
  cfg.canJump = true;
  cfg.allowSprinting = true;
  cfg.sprint = true;
  cfg.maxJumpHeight = 1;
  cfg.parkour = true;
  cfg.allowParkour = true;
  cfg.maxFallDistance = 3;
  cfg.allowFalling = true;
  cfg.breakBlocks = false;
  cfg.placeBlocks = false;
  cfg.scaffold = false;
  cfg.tower = false;
  cfg.avoidWater = false;
  cfg.avoidLava = true;
  cfg.allowDiagonals = true;
  cfg.thinkTimeout = 15000;
  cfg.searchRadius = 150;
  cfg.timeout = 40000;
  console.log('[SETUP] Патхфайндер: parkour=ON, breakBlocks=OFF');
}

async function forceStopPathfinder() {
  try { bot?.ashfinder?.stop(); } catch {}
  try { bot?.ashfinder?.setGoal?.(null); } catch {}
  try {
    if (bot?.ashfinder) {
      bot.ashfinder.isPathing = false;
      bot.ashfinder.path = null;
      bot.ashfinder.goal = null;
    }
  } catch {}
  try { bot.clearControlStates(); } catch {}
  state.traveling = false;
  state.pathingInProgress = false;
  await delay(300);
}

function clearAllIntervals() {
  if (stuckCheckInterval) { clearInterval(stuckCheckInterval); stuckCheckInterval = null; }
  if (movementCheckInterval) { clearInterval(movementCheckInterval); movementCheckInterval = null; }
  if (combatInterval) { clearInterval(combatInterval); combatInterval = null; }
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  stopStrafe();
}

function startStuckCheck() {
  if (stuckCheckInterval) clearInterval(stuckCheckInterval);
  if (bot?.entity?.position) {
    state.lastPosition = bot.entity.position.clone();
    state.lastDistance = getDistanceToTarget();
  }
  stuckCheckInterval = setInterval(async () => {
    if (state.isDead || state.reachedTarget || state.fullRestartInProgress || state.inCombat || state.isHandlingKicked) return;
    if (!bot?.entity?.position) return;
    const currentPos = bot.entity.position;
    const currentDist = getDistanceToTarget();
    const pathing = isCurrentlyPathing();
    if (state.lastPosition) {
      const moved = currentPos.distanceTo(state.lastPosition);
      const distChange = Math.abs(currentDist - (state.lastDistance || currentDist));
      const shouldBeMoving = pathing || state.traveling || state.pathingInProgress;
      if (shouldBeMoving && moved < 0.5 && distChange < 0.5 && !isAtTarget()) {
        state.pathingStuckCount++;
        console.log(`[STUCK] count=${state.pathingStuckCount}/${PATHING_STUCK_THRESHOLD}`);
        if (state.pathingStuckCount >= PATHING_STUCK_THRESHOLD) {
          state.pathingStuckCount = 0;
          await doFullRestart();
          return;
        }
        if (state.pathingStuckCount === 2 && bot.entity.onGround) {
          console.log('[STUCK] Пробую прыгнуть...');
          bot.setControlState('jump', true);
          await delay(100);
          bot.setControlState('jump', false);
        }
        if (state.pathingStuckCount === 4) {
          await forceStopPathfinder();
          await delay(500);
          walkToTarget();
          return;
        }
      } else if (moved > 0.5 || distChange > 0.5) {
        state.pathingStuckCount = 0;
        state.stuckCount = 0;
      }
      if (!shouldBeMoving && !isAtTarget() && !state.fullRestartInProgress) {
        state.stuckCount++;
        if (state.stuckCount >= MAX_STUCK_COUNT) {
          state.stuckCount = 0;
          walkToTarget();
        }
      }
    }
    state.lastPosition = currentPos.clone();
    state.lastDistance = currentDist;
  }, STUCK_CHECK_INTERVAL);
}

function startMovementMonitor() {
  if (movementCheckInterval) clearInterval(movementCheckInterval);
  movementCheckInterval = setInterval(async () => {
    if (state.isDead || state.fullRestartInProgress || state.inCombat || state.isHandlingKicked) return;
    checkPlateThreats();
    const hDist = getHorizontalDistance();
    const pathing = isCurrentlyPathing();
    if (hDist <= TARGET_TOLERANCE) {
      if (!state.reachedTarget) {
        console.log('[MONITOR] ✓ Цель достигнута!');
        state.reachedTarget = true;
        state.traveling = false;
        state.pathingStuckCount = 0;
        await forceStopPathfinder();
      }
      return;
    }
    if (state.reachedTarget && hDist > TARGET_TOLERANCE * 2) {
      state.reachedTarget = false;
      walkToTarget();
      return;
    }
    if (!state.reachedTarget && !pathing && !state.traveling && !state.pathingInProgress) {
      const now = Date.now();
      if (now - state.lastMoveAttempt > 3000) {
        state.lastMoveAttempt = now;
        walkToTarget();
      }
    }
  }, MOVEMENT_CHECK_INTERVAL);
}

async function doFullRestart() {
  if (state.fullRestartInProgress) return;
  state.fullRestartInProgress = true;
  console.log('[RESTART] === Полный рестарт ===');
  clearAllIntervals();
  await forceStopPathfinder();
  await delay(1000);
  await useCompass();
  await sendWarpExit();
  await delay(3000);
  state.traveling = false;
  state.pathingInProgress = false;
  state.reachedTarget = false;
  state.stuckCount = 0;
  state.pathingStuckCount = 0;
  state.inCombat = false;
  state.combatTarget = null;
  if (bot?.entity?.position) {
    state.lastDistance = getDistanceToTarget();
    state.lastPosition = bot.entity.position.clone();
  }
  setupPathfinder();
  startMovementMonitor();
  startStuckCheck();
  state.fullRestartInProgress = false;
  await delay(500);
  await walkToTarget();
}

async function walkToTarget() {
  if (state.isDead || state.fullRestartInProgress || state.inCombat || state.isHandlingKicked) return;
  if (isAtTarget()) {
    state.reachedTarget = true;
    state.traveling = false;
    return;
  }
  if (state.pathingInProgress || isCurrentlyPathing()) return;
  state.pathingInProgress = true;
  state.traveling = true;
  state.reachedTarget = false;
  state.lastMoveAttempt = Date.now();
  try {
    await bot.waitForChunksToLoad();
    await delay(500);
    state.pathingStuckCount = 0;
    state.lastDistance = getDistanceToTarget();
    const goal = new goals.GoalNear(
      new Vec3(TARGET_POS.x, TARGET_POS.y, TARGET_POS.z),
      TARGET_TOLERANCE
    );
    console.log(`[WALK] Иду к X: ${TARGET_POS.x} Y:${TARGET_POS.y} Z:${TARGET_POS.z}`);
    await bot.ashfinder.goto(goal);
    if (isAtTarget()) {
      state.reachedTarget = true;
      console.log('[WALK] ✓ Достигнуто! ');
    }
  } catch (err) {
    console.error('[WALK] Ошибка:', err.message);
    if (err.message?.includes('null') || err.message?.includes('boundingBox')) {
      await delay(2000);
      return;
    }
    if (err.message?.includes('noPath')) {
      console.log('[WALK] Путь не найден, пробую GoalXZ...');
      try {
        const goal2 = new goals.GoalXZ(TARGET_POS.x, TARGET_POS.z);
        await bot.ashfinder.goto(goal2);
      } catch (e) {
        console.log('[WALK] GoalXZ не удался, варп...');
        await doFullRestart();
      }
    }
  } finally {
    state.traveling = false;
    state.pathingInProgress = false;
  }
}

async function sendWarpExit() {
  try {
    await delay(randInt(400, 800));
    bot.chat('/warp exit');
    console.log('[WARP] /warp exit');
    await delay(2000);
    bot.chat('/warp exit');
    console.log('[WARP] /warp exit (повтор)');
    await delay(1500);
  } catch {}
}

async function retryWarpExitUntilSuccess(maxAttempts = 12) {
  if (state.warpRetryInProgress || state.isHandlingKicked || state.fullRestartInProgress) return;
  state.warpRetryInProgress = true;
  state.warpExitConfirmed = false;
  try {
    for (let attempt = 1; attempt <= maxAttempts && !state.warpExitConfirmed; attempt++) {
      console.log(`[WARP] Повторная попытка warp exit (#${attempt})`);
      await useCompass();
      await sendWarpExit();
      const waitStart = Date.now();
      while (!state.warpExitConfirmed && (Date.now() - waitStart) < 5000) {
        await delay(250);
      }
    }
    if (!state.warpExitConfirmed) {
      console.warn('[WARP] Не получил подтверждение warp exit после повтора');
    }
  } finally {
    state.warpRetryInProgress = false;
  }
}

async function retryCompassAfterCooldown(maxAttempts = 3, waitMs = 2000) {
  if (state.compassCooldownRetryInProgress || state.isHandlingKicked || state.fullRestartInProgress) return;
  state.compassCooldownRetryInProgress = true;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[COMPASS] КД сервера, повторная попытка #${attempt}`);
      await delay(waitMs);
      const used = await useCompass();
      if (used) {
        break;
      }
    }
  } finally {
    state.compassCooldownRetryInProgress = false;
  }
}

async function useCompass() {
  try {
    const hotbarStart = bot.inventory.hotbarStart || 36;
    const hotbarEnd = hotbarStart + 9;
    const compassSlot = bot.inventory.slots
      .slice(hotbarStart, hotbarEnd)
      .findIndex(i => i && i.name.toLowerCase().includes('compass'));

    if (compassSlot === -1) {
      console.log('[COMPASS] Не найден в хотбаре');
      return false;
    }

    const absoluteSlot = hotbarStart + compassSlot;
    const slotIdx = absoluteSlot - hotbarStart;
    await delay(randInt(120, 240));
    bot.setQuickBarSlot(slotIdx);
    console.log(`[COMPASS] Выбран слот ${slotIdx} (hotbar)`);
    await delay(randInt(120, 240));
    bot.activateItem();
    console.log('[COMPASS] ПКМ');
    await delay(randInt(200, 400));
    return true;
  } catch (err) {
    console.error('[COMPASS] Ошибка:', err.message);
    return false;
  }
}

async function fullSequence(useWarp = true) {
  if (state.fullRestartInProgress) return;
  state.fullRestartInProgress = true;
  clearAllIntervals();
  await forceStopPathfinder();
  state.traveling = false;
  state.pathingInProgress = false;
  state.reachedTarget = false;
  state.stuckCount = 0;
  state.pathingStuckCount = 0;
  state.inCombat = false;
  if (useWarp) {
    await useCompass();
    await sendWarpExit();
    await delay(2000);
  }
  await bot.waitForChunksToLoad();
  await delay(1000);
  if (bot?.entity?.position) {
    state.lastDistance = getDistanceToTarget();
    state.lastPosition = bot.entity.position.clone();
  }
  setupPathfinder();
  startMovementMonitor();
  startStuckCheck();
  state.fullRestartInProgress = false;
  await walkToTarget();
}

let reconnecting = false;

async function createBot() {
  await delay(6000);
  bot = mineflayer.createBot({
    host: 'mc.nexusmine.org',
    username: 'BotName',
    version: '1.16.5'
  });
  bot.loadPlugin(baritonePlugin);
  state = {
    traveling: false,
    reachedTarget: false,
    isDead: false,
    isFirstSpawn: true,
    lastPosition: null,
    lastDistance: null,
    stuckCount: 0,
    pathingStuckCount: 0,
    lastMoveAttempt: 0,
    pathingInProgress: false,
    fullRestartInProgress: false,
    inCombat: false,
    combatTarget: null,
    lastAttackTime: 0,
    lastHitTime: 0,
    lastDamageTaken: 0,
    hitBy: null,
    hitByTime: 0,
    combatStartTime: 0,
    hitCount: 0,
    comboCount: 0,
    strafeDirection: 1,
    isCrouching: false,
    enemies: new Map(),
    currentWeaponCooldown: COMBAT.WEAPON_COOLDOWNS.default,
    lastHealth: 20,
    plateDefenseMode: false,
    isHandlingKicked: false,
    warpRetryInProgress: false,
    warpExitConfirmed: false,
    compassCooldownRetryInProgress: false
  };
  hookEvents();
}

async function reconnectLater() {
  if (reconnecting) return;
  reconnecting = true;
  clearAllIntervals();
  await delay(randInt(5000, 8000));
  reconnecting = false;
  await createBot();
}

function setupConsoleInput() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '[BOT] > '
  });
  rl.prompt();
  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (bot && bot.entity && !state.isDead) {
      bot.chat(input);
      console.log(`[CONSOLE] Отправлено: ${input}`);
    } else {
      console.log('[CONSOLE] Бот не готов к отправке команд');
    }
    rl.prompt();
  });
  rl.on('close', () => {
    console.log('[CONSOLE] Консоль закрыта');
  });
}

function hookEvents() {
  bot.once('spawn', () => {
    console.log('[EVENT] Первый спавн');
    mcData = require('minecraft-data')(bot.version);
    state.isFirstSpawn = true;
    state.isDead = false;
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (!state.isDead && bot?.entity) {
        bot.chat('/ping');
      }
    }, 120000);
    setupConsoleInput();
  });
  
  bot.on('spawn', async () => {
    console.log('[EVENT] Спавн:', bot.entity.position);
    state.isDead = false;
    await bot.waitForChunksToLoad();
    await delay(1000);
    if (state.isFirstSpawn) {
      state.isFirstSpawn = false;
      await delay(1000);
      await fullSequence(true);
    }
  });
  
  bot.on('death', () => {
    console.warn('[EVENT] Смерть! ');
    state.isDead = true;
    state.inCombat = false;
    state.combatTarget = null;
    state.comboCount = 0;
    clearAllIntervals();
    forceStopPathfinder();
  });
  
  bot.on('respawn', async () => {
    console.log('[EVENT] Респавн');
    state.isDead = false;
    await delay(3000);
    await bot.waitForChunksToLoad();
    await delay(1000);
    await fullSequence(true);
  });
  
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const attacker = getNearestPlayer(COMBAT.ATTACK_RANGE + 2);
    if (attacker) {
      onDamageTaken(attacker);
    }
  });
  
  bot.on('health', () => {
    if (bot.health < (state.lastHealth || 20)) {
      const attacker = getNearestPlayer(COMBAT.ATTACK_RANGE + 2);
      if (attacker && !state.inCombat) {
        onDamageTaken(attacker);
      }
    }
    state.lastHealth = bot.health;
  });
  
  bot.on('message', async (message) => {
    const text = message.toString();
    console.log(message.toAnsi());
    const lowerText = text.toLowerCase();
    if (lowerText.includes('вы появились на варпе exit')) {
      state.warpExitConfirmed = true;
      return;
    }
    if (lowerText.includes('этой команды не существует')) {
      console.warn('[MESSAGE] Сервер не принял команду, повторяю warp exit');
      await retryWarpExitUntilSuccess();
      return;
    }
    if (lowerText.includes('совсем недавно выходили с этого сервера') || lowerText.includes('подождите немного')) {
      console.warn('[MESSAGE] Сервер просит подождать, повторяю использование компаса');
      await retryCompassAfterCooldown();
      return;
    }
    if (
      lowerText.includes('you were kicked') ||
      lowerText.includes('you have been kicked') ||
      lowerText.includes('kicked from') ||
      lowerText.includes('вы были кикнуты') ||
      lowerText.includes('вас кикнули')
    ) {
      console.log('[MESSAGE] Обнаружен кик! ');
      await handleKickedMessage();
      return;
    }
    if (
      lowerText.includes('на плите стоит другой игрок') ||
      lowerText.includes('столкни его') ||
      lowerText.includes('плите стоит игрок')
    ) {
      console.log('[MESSAGE] Игрок на плите!');
      const threat = getThreatsOnPlate()[0] || getNearestPlayer(COMBAT.THREAT_RANGE);
      if (threat) {
        await startCombat(threat, 'plate_defense');
      }
    }
  });
  
  bot.on('kicked', (reason) => {
    console.warn('[EVENT] Кик от сервера:', reason);
    clearAllIntervals();
    reconnectLater();
  });
  
  bot.on('end', (reason) => {
    console.warn('[EVENT] Дисконнект:', reason);
    clearAllIntervals();
    reconnectLater();
  });
  
  bot.on('error', (err) => {
    if (err.message?.includes('null') || err.message?.includes('boundingBox')) return;
    console.error('[EVENT] Ошибка:', err.stack);
  });
  
  process.on('uncaughtException', (err) => {
    if (err.message?.includes('null') || err.message?.includes('boundingBox')) return;
    console.error('[UNCAUGHT]', err);
  });
  
  process.on('unhandledRejection', (reason) => {
    const msg = String(reason);
    if (msg.includes('null') || msg.includes('boundingBox')) return;
    console.error('[UNHANDLED]', reason);
  });
  
  bot.on('path_update', (r) => {
    if (r.status === 'noPath') {
      console.log('[PATH] Путь не найден');
      state.pathingStuckCount++;
      if (state.pathingStuckCount >= 3) {
        state.pathingStuckCount = 0;
        setTimeout(() => doFullRestart(), 2000);
      }
    }
  });
  
  bot.on('goal_reached', () => {
    console.log('[PATH] ✓ goal_reached');
    state.reachedTarget = true;
    state.traveling = false;
    state.pathingInProgress = false;
    state.pathingStuckCount = 0;
  });
  
  bot.on('path_reset', () => {
    state.pathingInProgress = false;
  });
}

console.log('=== Запуск бота ===');
console.log(`Цель: X:${TARGET_POS.x} Y:${TARGET_POS.y} Z:${TARGET_POS.z}`);
console.log('');
console.log('=== WHITELIST (не атакуем) ===');
WHITELIST.forEach(name => console.log(`  - ${name}`));
console.log('');
(async () => { await createBot(); })();
