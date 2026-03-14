import Foundation
import UIKit

protocol Drawable {
    func draw()
    var color: String { get set }
}

struct Point {
    var x: Double
    var y: Double

    func distanceTo(_ other: Point) -> Double {
        let dx = x - other.x
        let dy = y - other.y
        return (dx * dx + dy * dy).squareRoot()
    }
}

class Shape: Drawable {
    var color: String
    private var name: String

    init(color: String, name: String) {
        self.color = color
        self.name = name
    }

    func draw() {
        print("Drawing \(name) in \(color)")
    }

    func area() -> Double {
        return 0.0
    }
}

class Circle: Shape {
    var radius: Double

    init(radius: Double, color: String) {
        self.radius = radius
        super.init(color: color, name: "Circle")
    }

    override func area() -> Double {
        return Double.pi * radius * radius
    }
}

enum Direction {
    case north
    case south
    case east
    case west

    func description() -> String {
        switch self {
        case .north: return "North"
        case .south: return "South"
        case .east: return "East"
        case .west: return "West"
        }
    }
}

extension Shape {
    func describe() -> String {
        return "\(color) shape"
    }
}

func createShapes() -> [Shape] {
    return [
        Circle(radius: 5.0, color: "red"),
        Shape(color: "blue", name: "Square"),
    ]
}
