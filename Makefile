ENGINE ?= docker
COMPOSE = $(ENGINE) compose
IMAGE   = signalfi-web

.PHONY: build up down restart logs shell clean

build:
	$(ENGINE) build -t $(IMAGE) .

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

logs:
	$(COMPOSE) logs -f

shell:
	$(ENGINE) exec -it $$($(COMPOSE) ps -q signalfi-web) sh

clean:
	$(COMPOSE) down --rmi local --volumes --remove-orphans
