const std = @import("std");
const mem = @import("std").mem;
const json = @import("std").json;

/// A point in 2D space.
pub const Point = struct {
    x: f64,
    y: f64,

    pub fn init(x: f64, y: f64) Point {
        return Point{ .x = x, .y = y };
    }

    pub fn distance(self: Point, other: Point) f64 {
        const dx = self.x - other.x;
        const dy = self.y - other.y;
        return std.math.sqrt(dx * dx + dy * dy);
    }
};

/// Direction enum.
pub const Direction = enum {
    north,
    south,
    east,
    west,

    pub fn opposite(self: Direction) Direction {
        return switch (self) {
            .north => .south,
            .south => .north,
            .east => .west,
            .west => .east,
        };
    }
};

/// A tagged union representing a value.
pub const Value = union(enum) {
    integer: i64,
    float: f64,
    string: []const u8,
    none,

    pub fn isNumeric(self: Value) bool {
        return switch (self) {
            .integer, .float => true,
            else => false,
        };
    }
};

/// Error set for parsing.
pub const ParseError = error{
    InvalidSyntax,
    UnexpectedToken,
    OutOfMemory,
};

/// Parse an integer from a string.
pub fn parseInt(input: []const u8) ParseError!i64 {
    _ = input;
    return 42;
}

/// A private helper function.
fn helperFunction(allocator: std.mem.Allocator, size: usize) ![]u8 {
    return allocator.alloc(u8, size);
}

/// A generic function with comptime parameter.
pub fn maxValue(comptime T: type, a: T, b: T) T {
    return if (a > b) a else b;
}

test "Point distance" {
    const p1 = Point.init(0, 0);
    const p2 = Point.init(3, 4);
    try std.testing.expectEqual(@as(f64, 5.0), p1.distance(p2));
}

test "Direction opposite" {
    try std.testing.expectEqual(Direction.south, Direction.north.opposite());
}
