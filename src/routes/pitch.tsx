import { createFileRoute, redirect } from '@tanstack/react-router'

// The pitch site is copied into public/pitch at build time (see package.json pitch:sync).
export const Route = createFileRoute('/pitch')({
  beforeLoad: () => {
    throw redirect({ href: '/pitch/index.html' })
  },
})
