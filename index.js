const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalNear } = goals

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 3000,
    username: 'Bot'
})

bot.loadPlugin(pathfinder)

let mcData
let logIds = []
let stopRequested = false

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)

  logIds = Object.values(mcData.blocksByName)
    .filter(b =>
      b.name.includes('_log') ||
      b.name.includes('_wood') ||
      b.name === 'crimson_stem' ||
      b.name === 'warped_stem'
    )
    .map(b => b.id)

  console.log(`[BOT] Spawned. Minecraft ${bot.version}`)
  bot.chat('Hello, World')
})

// --- Helpers ---

function log(msg) {
  console.log(`[BOT] ${msg}`)
  bot.chat(msg)
}

function getMovements() {
  const movements = new Movements(bot, mcData)
  for (const id of logIds) {
    movements.blocksCantBreak.add(id)
  }
  return movements
}

function isLog(block) {
  return block && logIds.includes(block.type)
}

function countItem(name) {
  return bot.inventory.items()
    .filter(item => item.name.includes(name))
    .reduce((sum, item) => sum + item.count, 0)
}

function logInventory(label) {
  const logs = bot.inventory.items()
    .filter(item => item.name.includes('_log') || item.name.includes('_wood'))
    .reduce((sum, item) => sum + item.count, 0)
  const saplings = countItem('sapling')
  const dirt = countItem('dirt')
  console.log(`[INV] ${label} | Logs: ${logs}, Saplings: ${saplings}, Dirt: ${dirt}`)
}

async function equipAxe() {
  if (bot.heldItem && bot.heldItem.name.includes('_axe')) return
  const axe = bot.inventory.items().find(item => item.name.includes('_axe'))
  if (axe) {
    try { await bot.equip(axe, 'hand') } catch (e) {}
  }
}

function stopAll() {
  stopRequested = true
  bot.pathfinder.stop()
  try { bot.stopDigging() } catch (e) {}
  bot.clearControlStates()
}

function waitForGoal(timeout = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout)
    function done() {
      clearTimeout(timer)
      bot.removeListener('goal_reached', done)
      bot.removeListener('path_stop', done)
      resolve()
    }
    bot.once('goal_reached', done)
    bot.once('path_stop', done)
  })
}

// --- Follow player ---

function followPlayer(username) {
  const player = bot.players[username]

  if (!player || !player.entity) {
    log(`I can't see you, ${username}!`)
    return
  }

  log(`Coming to you, ${username}!`)
  bot.pathfinder.setMovements(getMovements())
  bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true)
}

// --- Tree detection ---

function findNearestLog(maxDistance = 64, skipRoots = []) {
  const found = bot.findBlocks({
    matching: logIds,
    maxDistance,
    count: 20
  })

  for (const pos of found) {
    const skip = skipRoots.some(root =>
      root.x === pos.x && root.z === pos.z && Math.abs(root.y - pos.y) < 10
    )
    if (!skip) return pos
  }

  return null
}

function detectTree(startPos) {
  const startBlock = bot.blockAt(startPos)
  if (!isLog(startBlock)) return null

  // Trace down to find root
  let rootPos = startBlock.position.clone()
  while (true) {
    const below = bot.blockAt(rootPos.offset(0, -1, 0))
    if (isLog(below)) {
      rootPos = rootPos.offset(0, -1, 0)
    } else {
      break
    }
  }

  // Trace up from root to measure height
  const logs = []
  let pos = rootPos.clone()
  while (true) {
    const block = bot.blockAt(pos)
    if (isLog(block)) {
      logs.push(block)
      pos = pos.offset(0, 1, 0)
    } else {
      break
    }
  }

  return {
    root: rootPos,
    rootName: bot.blockAt(rootPos).name,
    height: logs.length,
    logs
  }
}

// --- BFS flood-fill to find ALL logs in the tree ---

function getTreeBlocks(rootPos) {
  const visited = new Set()
  const logs = []
  const queue = [rootPos]

  while (queue.length > 0) {
    const pos = queue.shift()
    const key = `${pos.x},${pos.y},${pos.z}`
    if (visited.has(key)) continue
    visited.add(key)

    const block = bot.blockAt(pos)
    if (!isLog(block)) continue

    logs.push(block)

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          queue.push(pos.offset(dx, dy, dz))
        }
      }
    }
  }

  return logs
}

function sortLogsForChopping(logs, trunkX, trunkZ) {
  logs.sort((a, b) => {
    if (b.position.y !== a.position.y) return b.position.y - a.position.y
    const distA = Math.abs(a.position.x - trunkX) + Math.abs(a.position.z - trunkZ)
    const distB = Math.abs(b.position.x - trunkX) + Math.abs(b.position.z - trunkZ)
    return distB - distA
  })
}

// --- Scaffold tracking & cleanup ---

const scaffoldNames = new Set(['dirt', 'cobblestone', 'netherrack'])
let scaffoldStack = []
let trackingScaffold = false

function onBlockPlaced(oldBlock, newBlock) {
  if (!trackingScaffold) return
  if (!newBlock || !scaffoldNames.has(newBlock.name)) return
  if (oldBlock && oldBlock.name !== 'air') return
  scaffoldStack.push(newBlock.position.clone())
}

function startTrackingScaffold() {
  scaffoldStack = []
  trackingScaffold = true
  bot.on('blockUpdate', onBlockPlaced)
}

function stopTrackingScaffold() {
  trackingScaffold = false
  bot.removeListener('blockUpdate', onBlockPlaced)
}

async function cleanupScaffold() {
  if (scaffoldStack.length === 0) return

  console.log(`[BOT] Cleaning ${scaffoldStack.length} scaffold block(s)`)

  while (scaffoldStack.length > 0) {
    if (stopRequested) return
    const pos = scaffoldStack.pop()
    const block = bot.blockAt(pos)
    if (!block || !scaffoldNames.has(block.name)) continue

    bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 3))
    await waitForGoal(10000)
    if (stopRequested) return

    const current = bot.blockAt(pos)
    if (!current || !scaffoldNames.has(current.name)) continue

    if (bot.canDigBlock(current)) {
      try { await bot.dig(current) } catch (e) {}
    }
  }
}

// --- Item collection ---

async function collectDroppedItems(collectPoints) {
  await new Promise(r => setTimeout(r, 600))

  const items = Object.values(bot.entities).filter(e => {
    if (e.displayName !== 'Item' && e.name !== 'item') return false
    if (!e.position) return false
    return collectPoints.some(p => e.position.distanceTo(p) < 6)
  })

  if (items.length === 0) return

  console.log(`[BOT] Collecting ${items.length} dropped item(s)`)

  for (const item of items) {
    if (stopRequested) return
    if (!item.isValid) continue

    try {
      bot.pathfinder.setGoal(new GoalNear(item.position.x, item.position.y, item.position.z, 0))
      await waitForGoal(5000)
    } catch (e) {}
  }
}

// --- Chop a single tree ---

async function chopTree(tree) {
  const allLogs = getTreeBlocks(tree.root)
  sortLogsForChopping(allLogs, tree.root.x, tree.root.z)

  log(`Chopping: ${allLogs.length} logs, root at (${tree.root.x}, ${tree.root.y}, ${tree.root.z})`)
  logInventory('before')

  startTrackingScaffold()

  let chopped = 0

  for (let i = 0; i < allLogs.length; i++) {
    if (stopRequested) return chopped

    const pos = allLogs[i].position
    const current = bot.blockAt(pos)
    if (!isLog(current)) continue

    bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 3))
    await waitForGoal(15000)
    if (stopRequested) return chopped

    const afterNav = bot.blockAt(pos)
    if (!isLog(afterNav)) continue
    if (!bot.canDigBlock(afterNav)) continue

    try {
      await equipAxe()
      await bot.dig(afterNav)
      chopped++
    } catch (e) {}
  }

  // Cleanup scaffold from chopping
  stopTrackingScaffold()
  await cleanupScaffold()

  // Collect dropped items
  const collectPoints = [tree.root]
  for (const l of allLogs) collectPoints.push(l.position)
  startTrackingScaffold()
  await collectDroppedItems(collectPoints)
  stopTrackingScaffold()
  await cleanupScaffold()

  logInventory('after')
  log(`Done: ${chopped}/${allLogs.length} logs chopped`)
  return chopped
}

// --- Main chop loop ---

async function chopTrees() {
  stopRequested = false
  log('Looking for trees...')
  bot.pathfinder.setMovements(getMovements())

  let treeCount = 0
  const detectedRoots = []

  while (!stopRequested) {
    const logPos = findNearestLog(64, detectedRoots)
    if (!logPos) {
      log(`No more trees. Chopped ${treeCount} tree(s).`)
      break
    }

    bot.pathfinder.setGoal(new GoalNear(logPos.x, logPos.y, logPos.z, 3))
    await waitForGoal(15000)
    if (stopRequested) break

    const tree = detectTree(logPos)
    if (!tree) continue

    treeCount++
    detectedRoots.push(tree.root)
    log(`Tree #${treeCount}: ${tree.rootName}, height ${tree.height}`)

    await chopTree(tree)
  }

  if (stopRequested) log('Stopped.')
}

// --- Chat commands ---

bot.on('chat', (username, message) => {
  if (username === bot.username) return

  const command = message.trim().toLowerCase()

  if (command === 'come') {
    stopAll()
    stopRequested = false
    followPlayer(username)
  } else if (command === 'chop') {
    stopAll()
    setTimeout(() => chopTrees(), 100)
  } else if (command === 'stop') {
    stopAll()
    log('Stopped.')
  }
})
