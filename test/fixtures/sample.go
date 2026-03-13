package sample

import "fmt"

type Handler interface {
	ServeHTTP(w Writer, r *Request)
}

type Router struct {
	routes map[string]Handler
}

func NewRouter() *Router {
	return &Router{routes: make(map[string]Handler)}
}

func (r *Router) Handle(path string, h Handler) {
	r.routes[path] = h
}

const (
	MaxRetries = 3
	Timeout    = 30
)

var (
	DefaultRouter *Router
)

func hello() string {
	return fmt.Sprintf("hello world")
}
