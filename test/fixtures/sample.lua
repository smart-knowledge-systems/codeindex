local json = require("json")
local utils = require("lib.utils")

-- Module table
local M = {}

-- Constants
M.VERSION = "1.0.0"
M.MAX_RETRIES = 3

--- Create a new player
function M.new(name, level)
    local self = {
        name = name,
        level = level or 1,
        health = 100,
        inventory = {},
    }
    return setmetatable(self, { __index = M })
end

--- Get player display name
function M:getName()
    return self.name
end

--- Add item to inventory
function M:addItem(item)
    table.insert(self.inventory, item)
end

--- Calculate damage based on level
function M:calculateDamage(baseDamage)
    return baseDamage * (1 + self.level * 0.1)
end

-- Local helper function
local function clamp(value, min, max)
    if value < min then return min end
    if value > max then return max end
    return value
end

--- Apply damage to player
function M:takeDamage(amount)
    self.health = clamp(self.health - amount, 0, 100)
end

--- Check if player is alive
function M:isAlive()
    return self.health > 0
end

function createGame(playerName)
    local player = M.new(playerName, 1)
    return {
        player = player,
        running = true,
    }
end

return M
