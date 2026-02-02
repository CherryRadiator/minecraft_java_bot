# Minecraft Java Bot

A Mineflayer bot that chops trees, collects logs/saplings, and follows players via in-game chat commands.

## Setup

```bash
npm install
```

Requires a Minecraft Java Edition server running on `localhost:3000` (configurable in `index.js`).

## Usage

```bash
node index.js
```

### Chat Commands

| Command | Description |
|---------|-------------|
| `chop`  | Find and chop all nearby trees (64 block radius), collect dropped items |
| `come`  | Follow the player who sent the command |
| `stop`  | Stop all actions immediately, freeze in place |

## How It Works

### Tree Detection
1. `findNearestLog` scans for log blocks within 64 blocks, skipping already-processed trees
2. `detectTree` traces the trunk down to find the root, then up to measure height
3. `getTreeBlocks` does a BFS flood-fill across all 26 neighbors to find every connected log (handles branches and big oaks)

### Chopping
- Logs are sorted top-down (highest Y first), with branches before trunk at the same level
- The bot navigates to each log and digs it, equipping an axe before every dig
- Logs are marked as unbreakable in pathfinder movements so the bot navigates *around* trees, not through them
- Pathfinder scaffolding is enabled so the bot can pillar up with dirt/cobblestone to reach high logs

### Scaffold Cleanup
- A `blockUpdate` listener tracks every dirt/cobblestone block the pathfinder places
- After chopping (and again after item collection), scaffold blocks are removed top-down
- This prevents leaving dirt pillars in the world

### Item Collection
- After each tree, the bot walks to dropped items within 6 blocks of any log position or the tree root
- Items are picked up by walking directly on top of them

## Project Structure

```
index.js       - Bot logic (single file)
package.json   - Dependencies
```

## Dependencies

- [mineflayer](https://github.com/PrismarineJS/mineflayer) - Minecraft bot framework
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) - Pathfinding plugin

## Configuration

Edit the top of `index.js` to change:

```js
const bot = mineflayer.createBot({
    host: 'localhost',  // server address
    port: 3000,         // server port
    username: 'Bot'     // bot username
})
```

## Console Output

The bot logs to both in-game chat and console. Console-only output includes inventory snapshots (`[INV]` prefix) before and after each tree showing log count, saplings, and dirt — useful for verifying nothing is being lost.

## Known Limitations

- Big trees (2x2 dark oak, large spruce) are detected via BFS but the bot may not reach all logs depending on terrain
- Pathfinder scaffolding isn't perfect — occasionally the bot may struggle to reach very high branches
- The bot uses whatever axe is in its inventory but won't craft new ones
