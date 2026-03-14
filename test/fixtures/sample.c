#include <stdio.h>
#include <stdlib.h>

typedef struct {
    int x;
    int y;
} Point;

typedef struct {
    Point origin;
    int width;
    int height;
} Rect;

Point point_new(int x, int y) {
    Point p = {x, y};
    return p;
}

int rect_area(const Rect *r) {
    return r->width * r->height;
}
