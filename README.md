# TECHI Platform

Modern MSP-style management platform built on top of RustDesk.

## Overview

TECHI Platform is a clean monolithic foundation for managed services operations with RustDesk as the native remote connection engine.

Phase 1 establishes the development skeleton only:
- FastAPI backend with PostgreSQL and SQLAlchemy
- React + Vite frontend shell with TailwindCSS and shadcn/ui readiness
- Docker Compose development environment
- Initial device, client, group, and operator models
- Native RustDesk launch strategy is planned for later phases

## Architecture

- `backend/`: FastAPI application, SQLAlchemy models, Alembic migrations
- `frontend/`: React + Vite UI shell, responsive layout, dark theme
- `docker-compose.yml`: PostgreSQL, backend, and frontend services
- `agent/`: placeholder for future Golang Windows service work

## Tech Stack

- Backend: Python, FastAPI, SQLAlchemy, Alembic
- Database: PostgreSQL
- Frontend: React, Vite, TypeScript, TailwindCSS
- Containerization: Docker Compose

## Local Setup

1. Copy environment example:
   ```bash
   cp .env.example .env
   ```

2. Start services with Docker Compose:
   ```bash
   docker compose up --build
   ```

3. Open the apps:
   - Backend: http://localhost:8000
   - Frontend: http://localhost:5173

## Development Workflow

- Backend code lives under `backend/app`
- Frontend code lives under `frontend/src`
- API versioning begins at `/api/v1`
- Health endpoint is available at `/health`

## Branch Workflow

- `main`: production-ready snapshots and stable foundation
- `dev`: active development for next phase

## Phase 1 Includes

- Backend foundation with config, database session, models, and basic API structure
- Frontend shell with navigation, dashboard, and placeholder pages
- Docker Compose local environment with PostgreSQL, backend, and frontend
- Documentation and simple project scaffolding

## What Is Intentionally Not Included Yet

- Full authentication and authorization flows
- Remote control features or web remote desktop
- Full device inventory business logic
- Monitoring/alerting integrations
- Agent implementation beyond future placeholder planning

## How to Test

- Backend health endpoint: `http://localhost:8000/health`
- Frontend homepage: `http://localhost:5173`

## Next Recommended Task

Implement the first backend CRUD endpoints for devices and wire the frontend device page to fetch actual inventory data.
