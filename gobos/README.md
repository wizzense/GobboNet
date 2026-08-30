# GobOS — the community awnix appliance

> The CentOS to the platform's RedHat (owner, 2026-08-29).

GobOS is a freely-forkable community edition of the AitherOS platform OS.
Same kernel (centos-bootc stream9), same awnix base (the public, immutable,
no-agent, no-account OS layer), **zero vendor strings**. Fork this repo,
change the brand, and produce your own bootable appliance.

## The layering (what you fork, what you keep)

| layer | what it is | you |
|---|---|---|
| `centos-bootc:stream9` | the kernel/OS upstream | keep |
| awnix base (`Containerfile.awnix`) | the public OS layer — 12 aw* tools, immutable, Apache-2.0 | keep |
| **this dir (`gobos/`)** | the brand + the GobboNet brain | **this is the fork point** |

The whole "CentOS" story is one file: `Containerfile.gobos`'s brand block.
Change `NAME`/`ID`/`PRETTY_NAME`, drop in your icon, `podman build` the same
base. Your appliance, their kernel.

## Build

```bash
# inside the monorepo, next to .DEPLOYMENT/standalone/bootc/:
podman build -t gobos:latest -f .PRODUCTS/.GOBBONET/upstream/gobos/Containerfile.gobos .
# or via the ISO Factory:
python -m factory resolve --scope .DEPLOYMENT/factory/scopes/gobos.yaml
python -m factory build --scope .DEPLOYMENT/factory/scopes/gobos.yaml --target iso --no-dry-run
```

## What a booted GobOS is

- Immutable, atomic-rollback, agent-handable — the awnix guarantees.
- No services, no agent, no account by default (the awnix contract). The
  GobboNet brain is a layer you opt into.
- Fully offline (`offline: true`, hub registration off) — a community
  appliance answers to its community, not to a vendor.

## Registry

`gobos` is registered in the ecosystem registry (id `gobos`, status planned)
pairing with awnix / awnode / gawbbonet / awfree.
