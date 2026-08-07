# Mana Vault

# List available recipes
default:
    @just --list

# Serve the app on localhost (Vite dev server)
serve:
    deno task dev

# Build the production bundle
build:
    deno task build

# Preview the production build on localhost
preview: build
    deno task preview

# Run the test suite
test:
    deno task test
