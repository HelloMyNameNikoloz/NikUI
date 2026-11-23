// Read-only sampler for a disposable measurement process; never a live engine.
#include <libproc.h>
#include <sys/resource.h>
#include <stdio.h>
#include <stdlib.h>
#include <mach/mach_time.h>
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    struct rusage_info_v4 value = {0};
    if (proc_pid_rusage(atoi(argv[1]), RUSAGE_INFO_V4, (rusage_info_t *)&value) != 0) return 3;
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    printf("{\"userNs\":%llu,\"systemNs\":%llu,\"interruptWakeups\":%llu,\"packageIdleWakeups\":%llu,\"residentBytes\":%llu,\"footprintBytes\":%llu}\n",
      value.ri_user_time * timebase.numer / timebase.denom, value.ri_system_time * timebase.numer / timebase.denom,
      value.ri_interrupt_wkups, value.ri_pkg_idle_wkups, value.ri_resident_size, value.ri_phys_footprint);
    return 0;
}
