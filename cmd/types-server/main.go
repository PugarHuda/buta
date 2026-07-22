// Package main provides a standalone entry point for the types-server.
package main

import (
	"log"

	"extension-scaffold/internal/config"
	"extension-scaffold/internal/typesserver"
	"extension-scaffold/pkg/decoder"
	"extension-scaffold/pkg/types"
)

func main() {
	registry := decoder.NewRegistry()
	types.RegisterDecoders(registry)

	s := typesserver.New(registry)
	log.Fatal(s.ListenAndServe(config.TypesServerPort))
}
