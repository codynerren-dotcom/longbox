/**
 * Identifies Longbox on every Metron request.
 * The API reference says to name the application, and an empty User-Agent is banned.
 * https://github.com/Metron-Project/metron/blob/master/api/README.md
 * https://github.com/Metron-Project/metron/blob/master/fail2ban/filter.d/metron-nginx-no-ua.conf
 */
export const METRON_USER_AGENT = "longbox/1.0 (personal comic shelf)";
