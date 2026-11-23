#include <stdio.h>

/* A disposable, locally compiled executable with an explicit ready/exit
 * protocol. Copied Apple platform binaries can be killed before GC runs. */
int main(void) {
    puts("ready");
    fflush(stdout);
    while (getchar() != EOF) {}
    return 0;
}
