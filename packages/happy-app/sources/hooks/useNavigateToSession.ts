import { useCallback } from "react";
import { usePathname, useRouter } from "expo-router";

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();

    return useCallback((sessionId: string) => {
        const href = `/session/${sessionId}` as const;
        if (pathname.startsWith('/session/')) {
            router.replace(href);
            return;
        }
        router.navigate(href);
    }, [pathname, router]);
}
