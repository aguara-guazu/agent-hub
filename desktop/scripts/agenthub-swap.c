#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <unistd.h>

static int reject(const char *message) {
  fprintf(stderr, "agenthub-swap: %s\n", message);
  return 64;
}

static int regular_path(const char *path, struct stat *result) {
  if (path[0] != '/') return 0;
  if (lstat(path, result) != 0 || S_ISLNK(result->st_mode)) return 0;
  return S_ISREG(result->st_mode) || S_ISDIR(result->st_mode);
}

int main(int argc, char **argv) {
  if (argc != 3) return reject("expected exactly two paths");
  struct stat left, right;
  if (!regular_path(argv[1], &left) || !regular_path(argv[2], &right)) return reject("paths must exist, be absolute, and not be symlinks");
  char left_copy[PATH_MAX], right_copy[PATH_MAX];
  if (strlcpy(left_copy, argv[1], sizeof(left_copy)) >= sizeof(left_copy) || strlcpy(right_copy, argv[2], sizeof(right_copy)) >= sizeof(right_copy)) return reject("path too long");
  if (strcmp(dirname(left_copy), dirname(right_copy)) != 0) return reject("paths must share a parent directory");
  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
    fprintf(stderr, "agenthub-swap: renameatx_np: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}
