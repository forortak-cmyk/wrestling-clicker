async function allRows(db, table, columns, configure = q => q) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await configure(db.from(table).select(columns))
      .order('telegram_id', { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}
async function commitUser(db, user, changes, operationId, extra = {}, withdrawal = null, adSession = null) {
  const { data, error } = await db.rpc('commit_game_operation', {
    p_telegram_id: user.telegram_id, p_revision: user.revision,
    p_changes: changes, p_operation_id: operationId,
    p_extra: extra, p_withdrawal: withdrawal, p_ad_session: adSession
  });
  if (error) throw error;
  return { data: data.user, response: data };
}
module.exports = { allRows, commitUser };
