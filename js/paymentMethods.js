// Single source of truth for payment method options across POS Walk-In, Layaway,
// and Scrap forms in this app -- previously redeclared independently per file with
// values that had already drifted (Layaway's own copy was missing "Store Sales
// Cash"). There is no CHECK constraint on any *_payments.payment_method column in
// the database, so this list (not the DB) is the actual source of truth for what a
// person can pick -- keep it in sync with the identical file in kittymae-inventory-v2
// (no shared asset pipeline between the two GitHub Pages repos, so each app keeps
// its own copy, same as every other shared-but-duplicated file in this codebase).
export const PAYMENT_METHODS = ['Cash', 'Terminal', 'Store Sales Cash', 'GCash', 'Bank Transfer', 'Other'];

// COD (Cash on Delivery) is POS-specific (Ren's spec section 185: "Add COD as POS
// payment method") -- it doesn't apply to a Layaway installment or a Scrap buy, so
// it's a separate list rather than added to PAYMENT_METHODS above, which those two
// still use unchanged. A COD payment starts life "Pending Collection" rather than
// immediately counted as collected money -- see sale_payments.payment_status and
// mark_cod_collected() in the database.
export const POS_PAYMENT_METHODS = ['Cash', 'Terminal', 'Store Sales Cash', 'GCash', 'Bank Transfer', 'COD', 'Other'];
