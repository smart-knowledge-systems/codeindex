#include <string>
#include <vector>

namespace shapes {

class Shape {
public:
    virtual double area() const = 0;
    virtual ~Shape() = default;
};

class Circle : public Shape {
public:
    explicit Circle(double radius) : radius_(radius) {}
    double area() const override;

private:
    double radius_;
};

double Circle::area() const {
    return 3.14159 * radius_ * radius_;
}

template<typename T>
class Container {
public:
    void add(T item);
    T get(int index) const;
};

}  // namespace shapes
