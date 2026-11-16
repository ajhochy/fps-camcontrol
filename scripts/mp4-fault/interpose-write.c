// Developer-only fault injector for the #67 MP4 close/recovery proof (never shipped, never loaded by the app).
// DYLD_INSERT_LIBRARIES-interposes write(2)/pwrite(2) for ONE regular file whose path ends with $FAULT_SUFFIX (default ".mp4"):
//   FAULT_LOG=<file>        append one line per write: seq, kind, file offset, length, monotonic seconds (a complete write trace, incl. the finalization sequence)
//   FAULT_KILL_AT=<N>       on the N-th write to that file...
//   FAULT_KILL_ON_PATCH=1   instead of a count: trigger on the 8-byte write at offset 44 that turns the placeholder into the final mdat (the very last step of a hybrid close)
//   FAULT_MODE=before|partial|after   ...SIGKILL self before the write, after writing half of the buffer (a torn write), or after it
// Build:  clang -dynamiclib -O1 -o interpose-write.dylib interpose-write.c
// Note: SIP strips DYLD_* across protected binaries (nice, sh), so the target must be exec'd directly.
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define INTERPOSE(replacement, replacee) \
  __attribute__((used)) static struct { const void* r; const void* o; } _interpose_##replacee \
  __attribute__((section("__DATA,__interpose"))) = { (const void*)(unsigned long)&replacement, (const void*)(unsigned long)&replacee }

static int is_target(int fd) {
  static int cache_fd = -1, cache_val = 0;
  struct stat st;
  if (fd < 3 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
  char path[1024];
  if (fcntl(fd, F_GETPATH, path) != 0) return 0;
  const char* suffix = getenv("FAULT_SUFFIX"); if (!suffix) suffix = ".mp4";
  size_t pl = strlen(path), sl = strlen(suffix);
  (void)cache_fd; (void)cache_val;
  return pl >= sl && strcmp(path + pl - sl, suffix) == 0;
}
static long g_seq = 0;
static void trace(off_t off, size_t len, const char* kind) {
  const char* log = getenv("FAULT_LOG"); if (!log) return;
  FILE* f = fopen(log, "a"); if (!f) return;
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  fprintf(f, "%ld %s %lld %zu %.6f\n", g_seq, kind, (long long)off, len, (double)ts.tv_sec + ts.tv_nsec / 1e9); fclose(f);
}
static ssize_t do_write(int fd, const void* buf, size_t n, off_t* at) {
  if (!is_target(fd)) return at ? pwrite(fd, buf, n, *at) : write(fd, buf, n);
  long seq = ++g_seq; const char* k = getenv("FAULT_KILL_AT"); long kill_at = k ? atol(k) : 0;
  off_t off = at ? *at : lseek(fd, 0, SEEK_CUR);
  trace(off, n, at ? "pwrite" : "write");
  if (getenv("FAULT_KILL_ON_PATCH") && off == 44 && n == 8) kill_at = seq;   /* FFmpeg lseeks to 44 and write()s the 8-byte mdat header */
  const char* mode = getenv("FAULT_MODE"); if (!mode) mode = "after";
  if (kill_at && seq == kill_at && strcmp(mode, "before") == 0) raise(SIGKILL);
  if (kill_at && seq == kill_at && strcmp(mode, "partial") == 0) {
    size_t half = n / 2; if (at) pwrite(fd, buf, half, *at); else write(fd, buf, half);
    raise(SIGKILL);
  }
  ssize_t r = at ? pwrite(fd, buf, n, *at) : write(fd, buf, n);
  if (kill_at && seq == kill_at) raise(SIGKILL);
  return r;
}
static ssize_t my_write(int fd, const void* buf, size_t n) { return do_write(fd, buf, n, NULL); }
static ssize_t my_pwrite(int fd, const void* buf, size_t n, off_t off) { return do_write(fd, buf, n, &off); }
INTERPOSE(my_write, write);
INTERPOSE(my_pwrite, pwrite);
