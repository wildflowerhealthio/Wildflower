import { createFileRoute } from '@tanstack/react-router'

import { ServerCertificateTab } from '../../server-certificate-tab.tsx'

/** `/servers/$domain/certificate`, the server page's Certificate tab. */
export const Route = createFileRoute('/_servers/servers/$domain/certificate')({
  component: ServerCertificateTab,
})
