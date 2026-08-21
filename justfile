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
    deno task test:e2e

search-db-by-name CARD_NAME:
    jq '.illustrations | to_entries[] | select(.value.name == "{{CARD_NAME}}")' data/output/metadata.json

# Resize an image to 816x612 in place (matches other input images)
resize-image FILE:
    ffmpeg -y -i "{{FILE}}" -vf scale=816:612 -q:v 3 "{{FILE}}.tmp.jpg" -loglevel error
    mv "{{FILE}}.tmp.jpg" "{{FILE}}"
