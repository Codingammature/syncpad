/** owner > editor > viewer. The owner is stored on the doc; everyone else in `members`. */
export const roleFor = (doc, userId) =>
  doc.ownerId === userId ? 'owner' : (doc.members.find((m) => m.userId === userId)?.role ?? null)

export const canWrite = (role) => role === 'owner' || role === 'editor'
