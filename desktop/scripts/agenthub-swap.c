#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 * Atomically exchanges an installed bundle and its staged replacement with renameatx_np(RENAME_SWAP).
 * Accepted shape only: <dir>/<Name>.app and <dir>/<Name>.app.incoming-<transaction id>, both real directories on the
 * same device, neither a symlink. The parent directory is fsynced after the swap so the exchange survives power loss.
 * Exit codes: 0 swapped and durable, 64 rejected before touching anything, 1 swap failed, 2 swapped but fsync failed.
 */

static int reject(const char *message) {
  fprintf(stderr, "agenthub-swap: %s\n", message);
  return 64;
}

static int real_directory(const char *path, struct stat *result) {
  if (path[0] != '/') return 0;
  if (lstat(path, result) != 0 || S_ISLNK(result->st_mode)) return 0;
  return S_ISDIR(result->st_mode);
}

static int ends_with(const char *value, const char *suffix) {
  size_t length = strlen(value), tail = strlen(suffix);
  return length > tail && strcmp(value + length - tail, suffix) == 0;
}

static int valid_transaction_id(const char *id) {
  size_t length = strlen(id);
  if (length < 8 || length > 64) return 0;
  for (const char *c = id; *c; c++)
    if (!((*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '-')) return 0;
  return 1;
}

/* `incoming` must be exactly `<installed basename>.incoming-<id>`. */
static int expected_pair(const char *installed, const char *incoming) {
  static const char marker[] = ".incoming-";
  size_t base = strlen(installed);
  if (!ends_with(installed, ".app") || strncmp(incoming, installed, base) != 0) return 0;
  if (strncmp(incoming + base, marker, sizeof(marker) - 1) != 0) return 0;
  return valid_transaction_id(incoming + base + sizeof(marker) - 1);
}

static int inherited_lock_fd(void) {
  const char *value = getenv("AGENTHUB_SWAP_LOCK_FD");
  const char *path = getenv("AGENTHUB_SWAP_LOCK_PATH");
  if (!value || !*value || !path || path[0] != '/') return -1;
  char *end = NULL;
  long fd = strtol(value, &end, 10);
  if (!end || *end || fd < 3 || fd > INT_MAX) return -1;
  struct stat held, expected;
  if (fstat((int)fd, &held) != 0 || lstat(path, &expected) != 0 || !S_ISREG(held.st_mode) || S_ISLNK(expected.st_mode)
      || held.st_dev != expected.st_dev || held.st_ino != expected.st_ino) return -1;
  if (flock((int)fd, LOCK_EX | LOCK_NB) != 0) return -1;
  return (int)fd;
}

int main(int argc, char **argv) {
  if (argc != 3) return reject("expected exactly two paths: <installed.app> <installed.app.incoming-id>");
  if (inherited_lock_fd() < 0) return reject("missing inherited swap lock");
  struct stat installed, incoming;
  if (!real_directory(argv[1], &installed) || !real_directory(argv[2], &incoming)) return reject("paths must be absolute, existing directories and not symlinks");
  if (installed.st_dev != incoming.st_dev) return reject("paths must be on the same device");
  char installed_dir[PATH_MAX], incoming_dir[PATH_MAX], installed_name[PATH_MAX], incoming_name[PATH_MAX];
  if (strlcpy(installed_dir, argv[1], sizeof(installed_dir)) >= sizeof(installed_dir) || strlcpy(incoming_dir, argv[2], sizeof(incoming_dir)) >= sizeof(incoming_dir)
      || strlcpy(installed_name, argv[1], sizeof(installed_name)) >= sizeof(installed_name) || strlcpy(incoming_name, argv[2], sizeof(incoming_name)) >= sizeof(incoming_name))
    return reject("path too long");
  /* dirname/basename may return a shared static buffer: copy each result before the next call. */
  char parent[PATH_MAX], other_parent[PATH_MAX], left[PATH_MAX], right[PATH_MAX];
  strlcpy(parent, dirname(installed_dir), sizeof(parent));
  strlcpy(other_parent, dirname(incoming_dir), sizeof(other_parent));
  strlcpy(left, basename(installed_name), sizeof(left));
  strlcpy(right, basename(incoming_name), sizeof(right));
  if (strcmp(parent, other_parent) != 0) return reject("paths must share a parent directory");
  if (!expected_pair(left, right)) return reject("names must be <Name>.app and <Name>.app.incoming-<transaction id>");
  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
    fprintf(stderr, "agenthub-swap: renameatx_np: %s\n", strerror(errno));
    return 1;
  }
  int directory = open(parent, O_RDONLY | O_DIRECTORY);
  if (directory < 0 || fsync(directory) != 0) {
    fprintf(stderr, "agenthub-swap: fsync of parent failed after swap: %s\n", strerror(errno));
    if (directory >= 0) close(directory);
    return 2;
  }
  close(directory);
  return 0;
}
