# Agent Hub — atajos del monorepo TypeScript/Electron

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

.PHONY: help install install-app dev test test-e2e lint typecheck build package seed clean

help: ## muestra esta ayuda
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

install: ## instala exactamente lo fijado en package-lock.json
	npm ci

dev: ## compila y abre la aplicación Electron
	npm run dev

test: ## unitarias, integración, renderer y E2E de procesos reales
	npm test
	npm run test:e2e

test-e2e: ## core + daemon + configuración + gateway stdio reales
	npm run test:e2e

lint: ## ESLint sobre TypeScript/JavaScript
	npm run lint

typecheck: ## TypeScript estricto de todos los workspaces
	npm run typecheck

build: ## compila paquetes, renderer y proceso Electron
	npm run build

package: ## genera el bundle Electron para la plataforma solicitada
	npm run package

install-app: ## empaqueta e instala Agent Hub en /Applications (macOS); SKIP_PACKAGE=1 reutiliza desktop/out
	bash scripts/install-macos.sh

seed: ## siembra el SQLite de desarrollo
	npm run build
	npm run seed

clean: ## elimina artefactos generados
	npm run clean
