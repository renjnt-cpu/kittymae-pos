// Branches -- "Handled by": the wrappers for the staff-handler functions (migration 253). Used by the POS Walk-In & COD, Scrap and Subasta tabs.
// Every rule (who may see, who may assign, who may be chosen, the branch fence) is checked again in the database.
import { supabase } from './supabaseClient.js?v=20261023a';

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

/** table: 'pos_sale' (record = sale_group_id) | 'scrap_entries' | 'subasta_items'. -> [{record_id, employee_id, name, employee_code, position, branch_name, active, assigned_by_name, assigned_at}] (records with no handler are simply absent) */
export const branchHandlersFor = (table, ids) => rpc('branch_handlers_for', { p_table: table, p_ids: ids });
/** The assignment history of one record, oldest first, with the names as they were at the time. */
export const branchHandlerHistory = (table, id) => rpc('branch_handler_history', { p_table: table, p_id: String(id) });
/** Who can be picked for a record of this branch: [{id, name, employee_code, position, branch_id, branch_name, at_branch, on_leave}] (needs the assign permission) */
export const listBranchHandlers = (branchId) => rpc('list_branch_handlers', { p_branch: branchId });
/** employeeId null = remove the handler. -> {ok, action: Assigned | Reassigned | Removed, previous, new} */
export const assignBranchHandler = (table, id, employeeId, note) => rpc('branch_handler_assign', { p_table: table, p_id: String(id), p_employee: employeeId || null, p_note: note || null });
