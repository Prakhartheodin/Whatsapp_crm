// npm run groups: print every group the linked number is in (name + ID).
// Stop the main service first: two sockets on one session knock each other out.
// Needs no MongoDB, so it is also the easiest way to link the number the first time.
import { startWhatsApp } from '../backend/whatsapp/connection.js'

await startWhatsApp({
  onStop: () => process.exit(1),
  onOpen: async (sock) => {
    // One call. It also returns member lists; they are ignored on purpose.
    const groups = Object.values(await sock.groupFetchAllParticipating())
    groups.sort((a, b) => a.subject.localeCompare(b.subject))
    console.log(`\n${groups.length} groups:\n`)
    for (const g of groups) console.log(`${g.subject}  |  ${g.id}`)
    console.log('\nCopy 4 IDs into .env as TARGET_GROUP_IDS=id1,id2,id3,id4\n')
    setTimeout(() => process.exit(0), 2000) // let the session keys finish saving
  },
})
