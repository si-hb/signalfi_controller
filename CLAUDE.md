# Claude Code Instructions — SignalFi Web Project

## Context

You are working in this directory on a project to rebuild the functionality of a Node-RED flow
as a standalone responsive mobile web application. The Node-RED flow file (`flows.json`) is
included in this directory — it is the source of truth for what this project does.

---

## Your Tasks (in order)

### 1. Understand the Flow

Read and analyse `flows.json` thoroughly.

- The flow runs in a Node-RED instance on a rack-mounted server
- It was built for a professional AV / building automation / IoT control environment
- Pay attention to:
  - Tab and subflow names (they reveal functional groupings)
  - `ui_` nodes — these describe the current dashboard UI (labels, groups, tabs, widgets)
  - `function` nodes — contain JavaScript logic explaining business rules
  - `mqtt in` / `mqtt out` nodes — reveal the data topics and message structure
  - `http in` / `http request` nodes — any REST API interactions
  - `inject`, `switch`, `change`, `template` nodes — control flow and data transformation
  - Node comments and info fields — often contain documentation

### 2. Write README.md

Create `README.md` in this directory. It should be a clear, well-structured document covering:

- **Overview** — What this system does in plain English (one paragraph)
- **Functional Areas** — Each logical section of the flow explained (what it controls, monitors, or communicates with)
- **Data Sources & Protocols** — MQTT topics, HTTP endpoints, external integrations found in the flow
- **Key Logic** — Notable business rules, state machines, or algorithms found in function nodes
- **Current UI** — Description of the existing Node-RED dashboard (tabs, controls, displays)
- **Glossary** — Any domain-specific terms, device names, or acronyms used in node labels

### 3. Web Application Plan

Create `PLAN.md` in this directory. This is your architectural and design plan for a new
responsive mobile web application that replicates the functionality of this Node-RED flow's
dashboard for use from any browser (phone, tablet, desktop).

The plan should include:

#### Backend
- What server technology you recommend and why (e.g. Node.js/Express, FastAPI, etc.)
- How the backend will communicate with the same MQTT broker and/or HTTP endpoints
  that the Node-RED flow uses
- Any WebSocket or SSE strategy for pushing live state to the browser
- Authentication considerations (if the existing system has any)

#### Frontend
- Framework recommendation and justification (e.g. React, Vue, plain JS, etc.)
- How real-time updates will be handled in the UI

#### UI Layout Proposal
Design a specific, concrete UI layout. For each screen / page / section describe:
- The layout structure (e.g. top nav, sidebar, card grid, bottom tab bar)
- Which controls go where (sliders, buttons, toggles, status indicators, etc.)
- How it adapts between mobile (portrait), tablet, and desktop
- Any colour scheme or visual style suggestions that suit an AV/control-room context

Include ASCII wireframes or a written description detailed enough that a developer
could build it without further clarification.

#### File & Folder Structure
Propose a directory layout for the new project.

#### Implementation Phases
Break the build into logical phases with clear deliverables for each phase.

---

## Notes

- Do not modify `flows.json` — treat it as read-only reference material
- Prioritise usability on a phone in portrait orientation — that is the primary use case
- The UI should feel like a professional control panel, not a generic CRUD app
- Avoid unnecessary dependencies; prefer simplicity and speed
- If anything in the flow is ambiguous, state your assumption in the plan

---

## Files in this directory

| File | Description |
|------|-------------|
| `flows.json` | Node-RED flow export — the source of truth |
| `CLAUDE.md` | These instructions (this file) |
| `README.md` | To be created by you — flow documentation |
| `PLAN.md` | To be created by you — web app architecture & UI plan |
