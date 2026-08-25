// These are checked explicitly per area (via a site:-scoped search) in
// addition to the general search. General search sometimes doesn't surface
// a specific publisher for a narrow hyperlocal query even when they've
// covered it -- this makes sure these three always get checked directly.
// Add/remove domains freely.

module.exports = ["thehindu.com", "newindianexpress.com", "telanganatoday.com"];
