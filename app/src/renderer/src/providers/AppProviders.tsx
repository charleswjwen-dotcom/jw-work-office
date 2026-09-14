import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@renderer/lib/query-client'

export function AppProviders({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
