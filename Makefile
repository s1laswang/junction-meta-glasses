# Judge entry points for HoldUp (junction-meta-glasses).
.PHONY: accept install typecheck test dev smoke

accept:
	bash scripts/judge_accept.sh

install:
	npm install

typecheck:
	npm run typecheck

test:
	npm -w server test

dev:
	npm run dev

smoke:
	npm -w server run smoke
