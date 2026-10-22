variable "IMAGE_REPO" {}

# Inline cache on published images survives Actions cache eviction; gha scopes are per target to avoid concurrent overwrites.
target "_common" {
  cache-from = [
    "type=registry,ref=${IMAGE_REPO}:latest",
    "type=registry,ref=${IMAGE_REPO}-game:latest",
    "type=gha,scope=sandbox-runtime",
    "type=gha,scope=sandbox-game",
  ]
}

target "runtime" {
  cache-to = ["type=inline", "type=gha,mode=max,scope=sandbox-runtime"]
}

target "game" {
  cache-to = ["type=inline", "type=gha,mode=max,scope=sandbox-game"]
}
