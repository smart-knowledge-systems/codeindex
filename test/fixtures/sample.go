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

func hello() string {
	return fmt.Sprintf("hello world")
}
