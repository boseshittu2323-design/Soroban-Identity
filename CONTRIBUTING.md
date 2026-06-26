# Contributing to Soroban Identity

Thanks for your interest in contributing. Here's everything you need to get started.

## Fork & Clone

```bash
git clone https://github.com/your-username/Soroban-Identity.git
cd Soroban-Identity
```

## Branch Naming

Use one of these prefixes:

- `feat/` — new features
- `fix/` — bug fixes
- `docs/` — documentation only

Example: `feat/credential-filter-ui`

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add credential type filter to CredentialsPanel
fix: handle deploy.sh exit codes
docs: update README quick start
```

## Local Setup

### Contracts (Rust)

```bash
rustup target add wasm32-unknown-unknown
cd contracts && cargo build --target wasm32-unknown-unknown --release
cargo test
```

### SDK (TypeScript)

```bash
cd sdk
npm install
npm run build
npm test
```

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

### Deploy to Testnet

```bash
export STELLAR_SECRET_KEY=S...
bash scripts/deploy.sh
```

## PR Checklist

Before opening a PR:

- [ ] Branch is named with the correct prefix
- [ ] Commits follow Conventional Commits format
- [ ] SDK tests pass (`npm test` in `sdk/`)
- [ ] No TypeScript errors (`npx tsc --noEmit` in `frontend/`)
- [ ] **SDK changes**: Update the `[Unreleased]` section in `sdk/CHANGELOG.md`
- [ ] PR description references the related issue (e.g. `Closes #17`)

## Linking a PR to an Issue

Include one of these in your PR description:

```
Closes #17
Fixes #18
Resolves #19
```

GitHub will automatically close the issue when the PR is merged.

## Questions?

Open a [Discussion](../../discussions) or comment on the relevant issue.
