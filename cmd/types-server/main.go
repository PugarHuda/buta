// Package main provides a standalone entry point for the types-server.
package main

import (
	"log"

	"buta/internal/config"
	"buta/internal/typesserver"
	"buta/pkg/decoder"
	"buta/pkg/types"
)

func main() {
	registry := decoder.NewRegistry()
	types.RegisterDecoders(registry)

	s := typesserver.New(registry)
	log.Fatal(s.ListenAndServe(config.TypesServerPort))
}
