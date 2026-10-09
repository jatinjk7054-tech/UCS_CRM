import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import db, { sql } from '../config/db.js';
import { getWorkerByLoginId, getWorkerByEmail, getWorkerById, updateWorker } from '../models/workerModel.js';
import { getBnfOperatorByLoginId, getBnfOperatorById, updateBnfOperator } from '../models/bnfOperatorModel.js';
import { getUserByEmail, getUserByName, getUserById, updateUser } from '../models/userModel.js';
import { getHRByEmail, getHRById, updateHR } from '../models/hrModel.js';
import { findValidImpersonationCode, markImpersonationCodeUsed } from '../models/impersonationCodeModel.js';
import { releaseOperatorSessions, getActiveSessionsForTarget, getActiveSessionTargets, clearOperatorCoverLabels, claimStations, releaseConflictingCovers } from '../models/workAsSessionModel.js';
import { resolveOperatorIdentity } from '../utils/workAs.js';
import { istDateStr, sessionHandoverPlan } from '../utils/froIdle.js';
import { isWorkerOnline } from '../socket.js';
import { authenticateAgent, getActiveAgentByWorkerId, getAgentById, getAgentByLoginId, setAgentPasswordHash } from '../models/crmAgentModel.js';
import { endSessionIdle, parkIdleState } from '../services/froIdleCommit.js';
import { closeOpenSession } from '../services/froTimeSessions.js';

dotenv.config();

// CRMs / admin and salary portals get a rolling 24h session; the mobile
// (Flutter) worker login override below emits tokens with no expiry.
const TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY = '60d';

// Block a FRO's own login once an agent holds their account.
//
// The point of assigning an agent is that the FRO stops being the person at the
// keyboard — otherwise the performance board cannot distinguish the two, and the
// whole feature is decorative. Scoped as tightly as it can be:
//
//   - only a worker actually named by an ACTIVE agent is blocked, so every other
//     FRO, and all ~20 non-FRO @ufs staff, are untouched;
//   - only after the password has already been verified, so a wrong password
//     still fails as a wrong password and nothing about the account is disclosed
//     to someone who does not have it;
//   - only where role resolves to 'fro', so an @ufs account of another kind is
//     never caught by the branch that happens to handle it.
//
// The message names the agent rather than just failing, because an FRO suddenly
// locked out of their own account has no other way to find out why.
// An FRO never signs in as themselves. Full stop.
//
// FROs are operated through the agent assigned to them; letting the FRO's own
// credentials stay live in parallel defeats the point of agents entirely,
// because one can still work the account while the other holds it. Every worker
// login branch calls this only after the password has matched and only for
// department 'fro', so a wrong password still fails as a wrong password and
// non-FRO staff are never affected.
const rejectIfCoveredFro = async (worker) => {
  if (!worker) return null;
  let agent = null;
  try {
    agent = await getActiveAgentByWorkerId(worker.id);
  } catch (e) {
    // crm_agents absent before migration 172: there is no agent to name, but
    // the FRO's own credentials are still not a login, so still block.
    if (!/crm_agents.*does not exist|relation.*crm_agents/i.test(e?.message || '')) throw e;
  }
  return {
    message: agent
      ? `This account is operated by ${agent.label}. Sign in with their login instead.`
      : 'FRO accounts sign in through their assigned agent. Ask your admin for the agent login.',
    covered_by: agent?.label,
  };
};

// Sign an agent in as the FRO they are assigned.
//
// The session is deliberately shaped exactly like a manual acting-FRO session —
// FRO id, role and department, impersonation set, the operator recorded in
// imposter_id/imposter_name — because that is what makes every downstream FRO
// screen work unchanged. Two consequences of that shape are load-bearing and
// worth stating:
//
//   - imposter_name is the AGENT LABEL, which is what stamps receipts raised in
//     this session with "Agent 2" (see accountsController's agentStamp) instead
//     of the FRO's name. worker_aliases then resolves that label back to the FRO
//     so the money still lands in the right collection.
//   - imposter_id is the agent's own uuid. workAsSessionModel.operator_user_id is
//     text with no foreign key, so it stores happily; but liveRowWorkerId must never
//     let that uuid reach a live row, which is why it special-cases agent sessions.
//     See backend/src/utils/workAs.js.
const issueAgentSession = async (agent, req, res) => {
  const agentId = String(agent.id);
  const workerId = String(agent.worker_id);
  const target = await getWorkerById(workerId);
  if (!target) {
    return res.status(500).json({ message: 'The FRO assigned to this agent no longer exists.' });
  }

  // Start from a clean cover. A previous shift on the same machine that ended in
  // a crash rather than a logout would otherwise leave a live session behind.
  //
  // Those stale covers end HERE, so the FROs they were holding have to be parked
  // exactly as they are on an explicit release — otherwise their rows keep an open
  // interval and a lapsed deadline that starts billing idle the moment this agent
  // stops covering them. Read the targets before releasing.
  await clearOperatorCoverLabels(agentId);
  const staleTargets = await getActiveSessionTargets(agentId).catch(() => []);
  await releaseOperatorSessions(agentId);
  for (const targetId of staleTargets) {
    await parkIdleState(targetId, { reason: 'cover_end', rearmGrace: true }).catch(() => {});
  }

  // Claim the FRO's stations so the cover relationship exists in
  // work_as_sessions. That row is what freezes the FRO's idle while they are
  // genuinely absent, and what keeps a second operator off their lists.
  let actStations = null;
  const withheldBy = [];
  const { data: owned, error: ownErr } = await db
    .from('fro_station_assignments')
    .select('station, ngo_id')
    .eq('fro_worker_id', workerId);
  if (ownErr) throw ownErr;

  if (owned && owned.length > 0) {
    const allPairs = owned.map((a) => ({ ngo_id: a.ngo_id, station: a.station }));
    let claim = await claimStations({
      targetWorkerId: workerId,
      pairs: allPairs,
      operatorUserId: agentId,
      operatorName: agent.label,
    });

    // A conflict here means somebody is manually acting as the same FRO right now.
    // Refusing the login outright would be the strict reading, but the agent is the
    // one who is actually rostered to this FRO and the other operator is not — so
    // they get in on whatever stations are actually free and are told which ones
    // they do not have. Locking a legitimate user out of their whole shift because
    // an admin left a cover running is the worse failure.
    if (claim.conflict?.length > 0) {
      const taken = new Set(
        claim.conflict
          .filter((c) => c.station != null)
          .map((c) => `${c.ngo_id ?? ''}|${String(c.station).trim()}`)
      );
      for (const c of claim.conflict) {
        if (c.station != null) withheldBy.push(`${c.ngo_id ?? ''}|${String(c.station).trim()}`);
      }
      const remaining = allPairs.filter((p) => !taken.has(`${p.ngo_id ?? ''}|${String(p.station).trim()}`));
      claim = remaining.length > 0
        ? await claimStations({ targetWorkerId: workerId, pairs: remaining, operatorUserId: agentId, operatorName: agent.label })
        : { ok: [], conflict: [] };
    }
    actStations = claim.ok;
  }

  // Author the cover label once, on the FRO's own row, so the admin board can say
  // "Priya, being worked by Agent 2". Cosmetic hint only — work_as_sessions is the
  // source of truth, and a failure here must not block the login.
  try {
    await db
      .from('fro_live_status')
      .update({ work_as_operator_id: agentId, work_as_operator_name: agent.label || null })
      .eq('worker_id', workerId);
  } catch (e) {
    // Non-fatal: label only.
  }

  // Freeze criterion for the FRO absent right now: close their stale open period
  // and lapsed deadline before the agent's heartbeats start a new window on that
  // row. A FRESH, active row means the FRO is actually at their desk — leave it.
  await parkCoveredFRORow(workerId);

  // Presence is recorded against the FRO, which is the whole reason this shows up
  // on the performance board as the FRO being online.
  //
  // Skipped for /worker/login for the same reason every other login skips it:
  // auth_sessions tracks the CRM web only, and an agent arriving through the
  // Flutter route should not be the one login that quietly opts out of that rule.
  if (req.route?.path !== '/worker/login') {
    await touchLogin(workerId, target.name, 'fro');
  }

  const stationPayload = actStations && actStations.length > 0 ? { act_stations: actStations } : {};
  const token = jwt.sign(
    {
      id: target.id,
      login_id: target.login_id,
      ngo_id: target.ngo_id,
      email: target.email,
      role: 'fro',
      department: target.department || 'fro',
      name: target.name,
      // Deliberately NOT an impersonation session. The admin assigned one
      // specific person to this FRO; that is the normal login, not a cover.
      // Stamping impersonation:true made the FRO panel render an "owner vs
      // acting" strip, which reads as if the agent is hijacking the account.
      impersonation: false,
      imposter_id: null,
      imposter_name: null,
      agent_user_id: agentId,
      agent_label: agent.label,
      ...stationPayload,
    },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  return res.json({
    token,
    role: 'fro',
    user: {
      id: target.id,
      name: target.name,
      email: target.email,
      login_id: target.login_id,
      ngo_id: target.ngo_id,
      role: 'fro',
      department: target.department,
      // Deliberately NOT an impersonation session. The admin assigned one
      // specific person to this FRO; that is the normal login, not a cover.
      // Stamping impersonation:true made the FRO panel render an "owner vs
      // acting" strip, which reads as if the agent is hijacking the account.
      impersonation: false,
      imposter_id: null,
      imposter_name: null,
      agent_user_id: agentId,
      agent_label: agent.label,
      must_change_password: !!agent.must_change_password,
      ...stationPayload,
    },
    message: `Signed in as ${agent.label}, working ${target.name}'s account`,
    ...(withheldBy.length > 0
      ? { warning: `Some stations are currently covered by another operator and were not assigned to you.`, withheld_stations: withheldBy }
      : {}),
  });
};

export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (
      email === process.env.ADMIN_EMAIL &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const token = jwt.sign(
        { id: 0, email, role: 'super_admin', name: 'Super Admin' },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
      );
      return res.json({ token, role: 'super_admin', user: { name: 'Super Admin', email, role: 'super_admin' }, message: 'Login successful' });
    }
    return res.status(401).json({ message: 'Invalid admin credentials' });
  } catch (error) {
    return res.status(500).json({ message: 'Login failed' });
  }
};

// Restricted login for the salary calculator app — only the Accounts
// department (workers with department account/accounts/admin or users with
// role accounts) and the super admin may log in.
export const salaryLogin = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ message: 'Identifier and password are required' });
    }
    const isEmail = identifier.includes('@');

    if (
      isEmail &&
      identifier === process.env.ADMIN_EMAIL &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const role = 'super_admin';
      const token = jwt.sign(
        { id: 0, email: identifier, role, name: 'Super Admin' },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
      );
      return res.json({ token, role, user: { name: 'Super Admin', email: identifier, role }, message: 'Login successful' });
    }

    const deptIsAccount = (d) => {
      const x = String(d || '').toLowerCase().trim();
      return x === 'account' || x === 'accounts' || x === 'admin';
    };

    const worker = await getWorkerByLoginId(identifier);
    if (worker) {
      if (worker.is_active === false || worker.employment_status === 'terminated') {
        return res.status(403).json({ message: 'Account is deactivated' });
      }
      if (!deptIsAccount(worker.department)) {
        return res.status(403).json({ message: 'Access denied. Only the Accounts department or Super Admin can log in.' });
      }
      const isMatch = await bcrypt.compare(password, worker.password);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid password' });
      }
      const role = 'accounts';
      const token = jwt.sign(
        { id: worker.id, login_id: worker.login_id, ngo_id: worker.ngo_id, role, department: worker.department },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
      );
      return res.json({
        token,
        role,
        user: { id: worker.id, name: worker.name, email: worker.email, login_id: worker.login_id, department: worker.department },
        message: 'Login successful',
      });
    }

    const userByEmail = isEmail ? await getUserByEmail(identifier) : null;
    const userByName = !isEmail ? await getUserByName(identifier) : null;
    const userRow = userByEmail || userByName;
    if (userRow) {
      if (userRow.is_active === false) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }
      if (userRow.role !== 'accounts' && userRow.role !== 'super_admin') {
        return res.status(403).json({ message: 'Access denied. Only the Accounts department or Super Admin can log in.' });
      }
      const isMatch = await bcrypt.compare(password, userRow.password_hash);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid password' });
      }
      const role = userRow.role;
      const token = jwt.sign(
        { id: userRow.id, ngo_id: userRow.ngo_id, email: userRow.email, role, name: userRow.name },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
      );
      const { password_hash, ...safeUser } = userRow;
      return res.json({ token, role, user: safeUser, message: 'Login successful' });
    }

    return res.status(401).json({ message: 'Invalid credentials' });
  } catch (error) {
    return res.status(500).json({ message: 'Login failed' });
  }
};

// ─── CRM login presence / logout tracking ─────────────────────────────
// Sessions are recorded for UCS CRM web logins only (NOT the Flutter
// /auth/worker/login flow). user_id = token-subject id — workers.id (uuid),
// users.id / hr.id (int), 0 / -1 for the env super-admin / user accounts.

async function touchLogin(userId, name, role) {
  try {
    const now = new Date().toISOString();
    const key = String(userId);
    // Preserve the same-day login anchor: a mid-day re-login (auto-logout +
    // login) must not wipe hours already worked today. logged_in_at only moves
    // forward on a new IST day (or a missing/first session).
    let loginAt = now;
    try {
      const { data } = await db
        .from('auth_sessions')
        .select('logged_in_at')
        .eq('user_id', key)
        .maybeSingle();
      if (data?.logged_in_at) {
        const sameIstDay = (a, b) =>
          new Date(new Date(a).getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10) ===
          new Date(new Date(b).getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (sameIstDay(data.logged_in_at, now)) loginAt = data.logged_in_at;
      }
    } catch (_) {
      // First login / no row — keep the fresh anchor.
    }
    await db.from('auth_sessions').upsert(
      {
        user_id: key,
        client: 'crm',
        name: name || null,
        role: role || null,
        logged_in_at: loginAt,
        last_active_at: now,
        logged_out_at: null,
      },
      { onConflict: 'user_id' }
    );
  } catch (e) {
    console.warn('[auth] login touch failed:', e?.message || String(e));
  }
}

async function recordCrmLogin(uid, nm, rl, routePath) {
  if (routePath === '/worker/login') return;
  return touchLogin(uid, nm, rl);
}

// Explicit logout: mark the open session logged out and append a logout event
// (drives the per-user logout counts in Telecaller Performance).
// Exchanges a refresh token for a fresh access token. The refresh token carries
// no `exp` claim (see unifiedLogin), so this endpoint keeps working until the
// worker logs out and the app drops the stored refresh token.
export const refreshAccessToken = async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ message: 'refresh_token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refresh_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    if (decoded.type !== 'refresh' || !decoded.id) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const { id, login_id, ngo_id, name, role, department } = decoded;
    const token = jwt.sign(
      { id, login_id, ngo_id, name, role, department },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    return res.json({ token, refresh_token: refresh_token });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const logout = async (req, res) => {
  try {
    const u = req.user || {};
    // An agent's shift ends when they log out, so their cover has to end with it.
    // Without this the stations stay reserved for the rest of the TTL and the FRO
    // keeps reading as "covered and away" — so accrues no idle and no figures —
    // until an admin manually clears it.
    if (u.agent_user_id) {
      const agentId = String(u.agent_user_id);
      try {
        await clearOperatorCoverLabels(agentId);
        // Same reason as releaseWorkAs: park the FROs whose cover ends with this
        // logout, read before the release.
        const endingTargets = await getActiveSessionTargets(agentId).catch(() => []);
        await releaseOperatorSessions(agentId);
        for (const targetId of endingTargets) {
          await parkIdleState(targetId, { reason: 'cover_end', rearmGrace: true }).catch(() => {});
        }
        // Unbrand the FRO this agent was working, for this agent only. Keyed on
        // the operator id so a different cover on the same FRO is left alone.
        if (u.impersonation && u.id != null) {
          await db
            .from('fro_live_status')
            .update({ work_as_operator_id: null, work_as_operator_name: null })
            .eq('worker_id', String(u.id))
            .eq('work_as_operator_id', agentId);
        }
      } catch (e) {
        console.warn('[auth] agent cover release failed:', e?.message || String(e));
      }
    }
    const uid = u.id;
    if (uid === undefined || uid === null) return res.json({ message: 'Logged out' });
    const key = String(uid);
    const now = new Date().toISOString();
    await sql(`UPDATE auth_sessions SET logged_out_at = $1 WHERE user_id = $2 AND logged_out_at IS NULL`, [now, key]);
    // An FRO signing out mid-idle would otherwise lose the open period from both
    // the day total and the monthly salary figure. Non-fatal and a no-op for
    // anyone without a live-status row.
    //
    // endSessionIdle, not commitIdleOnExit(key): the heartbeat files on the HUMAN
    // at the keyboard, so under a work-as session that is the operator, not
    // req.user.id (the painted FRO). Committing against the painted id banked
    // idle on the wrong person and left the operator's own interval running to
    // shift end. It now closes both identities when they differ.
    try {
      const { human, painted } = await endSessionIdle(u);
      // The operator's own CRM session must close too, or presence keeps reading
      // them as online after they signed out of somebody else's panel.
      if (human && painted && human !== painted) {
        await sql(
          `UPDATE auth_sessions SET logged_out_at = $1 WHERE user_id = $2 AND logged_out_at IS NULL`,
          [now, human]
        );
      }
    } catch (e) {
      console.warn('[auth] FRO idle commit on logout failed:', e?.message || String(e));
    }
    try {
      await db.from('auth_logout_events').insert({
        user_id: key,
        client: 'crm',
        name: u.name || null,
        role: u.role || null,
        logged_out_at: now,
      });
    } catch (e) {
      console.warn('[auth] logout event insert failed:', e?.message || String(e));
    }
    return res.json({ message: 'Logged out' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const unifiedLogin = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    console.log('[LOGIN] identifier:', JSON.stringify(identifier), 'endsWith @ufs:', identifier?.endsWith('@ufs'));
    if (!identifier || !password) {
      return res.status(400).json({ message: 'Identifier and password are required' });
    }

    const isUfsLogin = identifier.endsWith('@ufs');
    const isEmail = !isUfsLogin && identifier.includes('@');
    // /auth/worker/login is used by the Flutter apps -> token never expires;
    // every CRM login (/auth/login) -> 24h.
    const expiry = req.route?.path === '/worker/login' ? undefined : TOKEN_EXPIRY;
    const signOptions = expiry ? { expiresIn: expiry } : {};

    // Beneficiaries app login gate: when the client declares itself, only
    // accounts in the bnf_operators table may sign in. Everything else is
    // denied. Operators have their own table (not workers).
    const isAppLogin = req.body.client === 'beneficiaries';
    const appDenied = () => res.status(403).json({ message: 'Access denied. Only designated operators can log into the Beneficiaries app.' });

    // The HR dataforms are the one surface where a FRO signs in as themselves.
    //
    // Every other login refuses a FRO's own credentials outright (see
    // rejectIfCoveredFro), because assigning an agent means the FRO stops being
    // the person at the keyboard — and that only matters while the FRO is WORKING
    // their account. The dataforms collect the FRO's own personnel record (address,
    // bank, signature), which is not field work and which no agent can submit on
    // their behalf, so the rule applied there only leaves the form unfillable.
    //
    // Deliberately narrow, on both axes:
    //   - keyed on a marker the dataforms send rather than on the route alone,
    //     because /auth/worker/login is shared with the Flutter attendance apps
    //     and the legacy clients, where the agent rule must still hold;
    //   - and paired with the route, so no CRM login can ever be exempted by
    //     adding the marker to the CRM client.
    //
    // Nothing here widens what the FRO can reach. The token is their own ordinary
    // worker token over their own record, the dataform endpoints sit behind plain
    // `authenticate` with no role gate, and recordCrmLogin still skips this route
    // so no CRM session or FRO idle timer is touched.
    const HR_FORM_CLIENTS = new Set(['hr_form', 'submitted_form']);
    const isHrFormLogin =
      req.route?.path === '/worker/login' && HR_FORM_CLIENTS.has(String(req.body.client || '').trim());

    if (isAppLogin) {
      const operator = await getBnfOperatorByLoginId(identifier);
      if (!operator || operator.is_active === false) return appDenied();
      const isMatch = await bcrypt.compare(password, operator.password);
      if (!isMatch) return res.status(401).json({ message: 'Invalid password' });
      const role = 'worker';
      const token = jwt.sign(
        { id: operator.id, login_id: operator.login_id, name: operator.name, role, department: 'operator' },
        process.env.JWT_SECRET,
        signOptions
      );
      return res.json({
        token,
        role,
        user: { id: operator.id, name: operator.name, email: operator.email, login_id: operator.login_id, department: 'operator' },
        message: 'Login successful',
      });
    }

    // CRM login agents resolve FIRST, ahead of every worker lookup.
    //
    // Placement is load-bearing in both directions. An agent's login_id is agentN,
    // which no worker uses, so a later branch could never match it — but the
    // reverse matters far more: the FRO an agent covers is an ordinary worker, so
    // a later branch WOULD happily match a worker's identifier and let whoever
    // typed it walk in as that FRO. Resolving agents first means the identifier
    // decides which credential store is consulted at all.
    {
      let attempt;
      try {
        attempt = await authenticateAgent(identifier, password);
      } catch (e) {
        // crm_agents is a feature table that only exists once its migration runs.
        // Treating a missing-table error as "no such agent" keeps normal worker
        // logins working before the migration is applied.
        if (/crm_agents.*does not exist|relation.*crm_agents/i.test(e?.message || '')) {
          attempt = { ok: false, reason: 'not_found' };
        } else {
          throw e;
        }
      }
      if (attempt.ok) return await issueAgentSession(attempt.agent, req, res);
      // Only a clean "no such agent" falls through to the other stores. An agent
      // that exists but is deactivated — or whose FRO is no longer active — must
      // NOT fall through, or it would get another chance to authenticate through
      // the worker tables and defeat the reason it was turned off.
      if (attempt.reason !== 'not_found') {
        const message = attempt.reason === 'inactive'
          ? 'This agent login is deactivated.'
          : attempt.reason === 'bad_password'
            ? 'Invalid password'
            : 'This agent login is unavailable because the assigned FRO account is not active.';
        return res.status(attempt.reason === 'bad_password' ? 401 : 403).json({ message });
      }
    }

    if (isUfsLogin) {
      const worker = await getWorkerByLoginId(identifier);
      if (!worker) {
        return res.status(401).json({ message: 'Invalid login ID' });
      }
      if (worker.is_active === false || worker.employment_status === 'terminated') {
        return res.status(403).json({ message: 'Account is deactivated' });
      }
      const isMatch = await bcrypt.compare(password, worker.password);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid password' });
      }
      // A covered FRO no longer signs in as themselves. Checked only after the
      // password matched, so nothing is disclosed to a caller who does not hold it.
      // Skipped for the HR dataforms, which exist to collect the FRO's own record.
      if (!isHrFormLogin && String(worker.department || '').toLowerCase().trim() === 'fro') {
        const covered = await rejectIfCoveredFro(worker);
        if (covered) return res.status(403).json(covered);
      }
      const dept = (worker.department || '').toLowerCase().trim();
      // A FRO signing in on a different machine hands over from their previous
      // session, so the gap between the two panels is not billed as their idle.
      if (dept === 'fro' && !isHrFormLogin) {
        await reconcileSessionHandover(worker.id);
      }
      let role;
      if (dept === 'hr') role = 'hr';
      else if (dept.includes('recruit')) role = 'recruiter';
      else if (dept === 'admin') role = 'accounts';
      else if (dept === 'fro') role = 'fro';
      else if (dept === 'ngo admin') role = 'admin';
      else if (dept === 'digital' || dept.includes('develop')) role = 'digital';
      else if (dept.includes('event')) role = 'event_head';
      else role = 'worker';
      const claims = { id: worker.id, login_id: worker.login_id, ngo_id: worker.ngo_id, name: worker.name, role, department: worker.department };

      // Apps that declare themselves get the short-lived access token +
      // long-lived refresh token pair. The refresh token is intentionally
      // issued WITHOUT an expiry so a worker never gets logged out of the
      // mobile app; access is still capped at 24h and silently renewed.
      const isAppClient = String(req.body.client || '').trim() === 'attendance';
      const token = jwt.sign(
        claims,
        process.env.JWT_SECRET,
        isAppClient ? { expiresIn: TOKEN_EXPIRY } : signOptions
      );
      let refreshToken = null;
      if (isAppClient) {
        // No expiresIn => no `exp` claim => this token does not expire.
        refreshToken = jwt.sign(
          { ...claims, type: 'refresh' },
          process.env.JWT_SECRET
        );
      }
await recordCrmLogin(worker.id, worker.name, role, req.route?.path);
      const body = {
        token,
        role,
        user: { id: worker.id, name: worker.name, email: worker.email, login_id: worker.login_id, ngo_id: worker.ngo_id, gender: worker.gender, dob: worker.dob, department: worker.department },
        message: 'Login successful',
      };
      if (refreshToken) body.refresh_token = refreshToken;
      return res.json(body);
    }

    if (isEmail) {
      if (
        identifier === process.env.ADMIN_EMAIL &&
        password === process.env.ADMIN_PASSWORD
      ) {
        const token = jwt.sign(
          { id: 0, email: identifier, role: 'super_admin', name: 'Super Admin' },
          process.env.JWT_SECRET,
          signOptions
        );
        await recordCrmLogin(0, 'Super Admin', 'super_admin', req.route?.path);
        return res.json({ token, role: 'super_admin', user: { name: 'Super Admin', email: identifier, role: 'super_admin' }, message: 'Login successful' });
      }

      if (
        identifier === process.env.USER_EMAIL &&
        password === process.env.USER_PASSWORD
      ) {
        const token = jwt.sign(
          { id: -1, email: identifier, role: 'user', name: 'User' },
          process.env.JWT_SECRET,
          signOptions
        );
        await recordCrmLogin(-1, 'User', 'user', req.route?.path);
        return res.json({ token, role: 'user', user: { name: 'User', email: identifier, role: 'user' }, message: 'Login successful' });
      }

      const user = await getUserByEmail(identifier);
      if (user) {
        if (user.is_active === false) {
          return res.status(403).json({ message: 'Account is deactivated' });
        }
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
          return res.status(401).json({ message: 'Invalid password' });
        }
        const token = jwt.sign(
          { id: user.id, ngo_id: user.ngo_id, email: user.email, role: user.role, name: user.name },
          process.env.JWT_SECRET,
          signOptions
        );
        await recordCrmLogin(user.id, user.name, user.role, req.route?.path);
        const { password_hash, ...safeUser } = user;
        return res.json({ token, role: user.role, user: safeUser, message: 'Login successful' });
      }

      const hr = await getHRByEmail(identifier);
      if (hr) {
        if (hr.is_active === false) {
          return res.status(403).json({ message: 'Account is deactivated' });
        }
        const isMatch = await bcrypt.compare(password, hr.password_hash);
        if (!isMatch) {
          return res.status(401).json({ message: 'Invalid password' });
        }
        const token = jwt.sign(
          { id: hr.id, ngo_id: hr.ngo_id, email: hr.email, role: 'hr', name: hr.name },
          process.env.JWT_SECRET,
          signOptions
        );
        await recordCrmLogin(hr.id, hr.name, 'hr', req.route?.path);
        const { password_hash, ...safeHR } = hr;
        return res.json({ token, role: 'hr', user: safeHR, message: 'Login successful' });
      }

      // Allow workers to log in with custom ids like ngo@fro (not @ufs). This covers renamed NGO admin logins.
      const workerByLogin = await getWorkerByLoginId(identifier);
      if (workerByLogin) {
        if (workerByLogin.is_active === false || workerByLogin.employment_status === 'terminated') {
          return res.status(403).json({ message: 'Account is deactivated' });
        }
        const isMatch = await bcrypt.compare(password, workerByLogin.password);
        if (!isMatch) {
          return res.status(401).json({ message: 'Invalid password' });
        }
        // Custom worker ids (ngo@fro and friends) reach the FROs too, so the
        // covered-FRO block has to be applied here as well or it is trivially
        // bypassed by using the FRO's alternate identifier.
        if (!isHrFormLogin && String(workerByLogin.department || '').toLowerCase().trim() === 'fro') {
          const covered = await rejectIfCoveredFro(workerByLogin);
          if (covered) return res.status(403).json(covered);
        }
        const dept = (workerByLogin.department || '').toLowerCase().trim();
        if (dept === 'fro' && !isHrFormLogin) {
          await reconcileSessionHandover(workerByLogin.id);
        }
        let wRole;
        if (dept === 'hr') wRole = 'hr';
        else if (dept.includes('recruit')) wRole = 'recruiter';
        else if (dept === 'admin') wRole = 'accounts';
        else if (dept === 'fro') wRole = 'fro';
        else if (dept === 'ngo admin') wRole = 'admin';
        else if (dept === 'digital' || dept.includes('develop')) wRole = 'digital';
        else if (dept.includes('event')) wRole = 'event_head';
        else wRole = 'worker';
        const token = jwt.sign(
          { id: workerByLogin.id, login_id: workerByLogin.login_id, ngo_id: workerByLogin.ngo_id, name: workerByLogin.name, role: wRole, department: workerByLogin.department },
          process.env.JWT_SECRET,
          signOptions
        );
        await recordCrmLogin(workerByLogin.id, workerByLogin.name, wRole, req.route?.path);
        return res.json({
          token,
          role: wRole,
          user: { id: workerByLogin.id, name: workerByLogin.name, email: workerByLogin.email, login_id: workerByLogin.login_id, ngo_id: workerByLogin.ngo_id, department: workerByLogin.department },
          message: 'Login successful',
        });
      }

      // Volunteers on the Online Form do not have a UFS id — their login_id is
      // usually something like "shawn@ufs" while the address they remember is the
      // one on their record. Last in the chain, so users/hrs/NGO-admin logins
      // above keep winning exactly as before.
      const workerByEmail = await getWorkerByEmail(identifier);
      if (workerByEmail) {
        if (workerByEmail.is_active === false || workerByEmail.employment_status === 'terminated') {
          return res.status(403).json({ message: 'Account is deactivated' });
        }
        const isMatch = await bcrypt.compare(password, workerByEmail.password);
        if (!isMatch) {
          return res.status(401).json({ message: 'Invalid password' });
        }
        // 49 of the 53 FROs have an email on record and this is the branch they
        // sign in through, so the covered-FRO block has to be here too or they
        // would keep working their own accounts while nominally being covered.
        if (!isHrFormLogin && String(workerByEmail.department || '').toLowerCase().trim() === 'fro') {
          const covered = await rejectIfCoveredFro(workerByEmail);
          if (covered) return res.status(403).json(covered);
        }
        const eDept = (workerByEmail.department || '').toLowerCase().trim();
        if (eDept === 'fro' && !isHrFormLogin) {
          await reconcileSessionHandover(workerByEmail.id);
        }
        let eRole;
        if (eDept === 'hr') eRole = 'hr';
        else if (eDept.includes('recruit')) eRole = 'recruiter';
        else if (eDept === 'admin') eRole = 'accounts';
        else if (eDept === 'fro') eRole = 'fro';
        else if (eDept === 'ngo admin') eRole = 'admin';
        else if (eDept === 'digital' || eDept.includes('develop')) eRole = 'digital';
        else if (eDept.includes('event')) eRole = 'event_head';
        else eRole = 'worker';
        const token = jwt.sign(
          { id: workerByEmail.id, login_id: workerByEmail.login_id, ngo_id: workerByEmail.ngo_id, name: workerByEmail.name, role: eRole, department: workerByEmail.department },
          process.env.JWT_SECRET,
          signOptions
        );
        await recordCrmLogin(workerByEmail.id, workerByEmail.name, eRole, req.route?.path);
        return res.json({
          token,
          role: eRole,
          user: { id: workerByEmail.id, name: workerByEmail.name, email: workerByEmail.email, login_id: workerByEmail.login_id, ngo_id: workerByEmail.ngo_id, department: workerByEmail.department },
          message: 'Login successful',
        });
      }

      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const userFromName = await getUserByName(identifier);
    if (userFromName) {
      if (userFromName.is_active === false) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }
      const isMatch = await bcrypt.compare(password, userFromName.password_hash);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid password' });
      }
      const token = jwt.sign(
        { id: userFromName.id, ngo_id: userFromName.ngo_id, email: userFromName.email, role: userFromName.role, name: userFromName.name },
        process.env.JWT_SECRET,
        signOptions
      );
      await recordCrmLogin(userFromName.id, userFromName.name, userFromName.role, req.route?.path);
      const { password_hash, ...safeUser } = userFromName;
      return res.json({ token, role: userFromName.role, user: safeUser, message: 'Login successful' });
    }

    const worker = await getWorkerByLoginId(identifier);
    if (!worker) {
      return res.status(401).json({ message: 'Invalid login ID' });
    }
    if (worker.is_active === false || worker.employment_status === 'terminated') {
      return res.status(403).json({ message: 'Account is deactivated' });
    }
    const isMatch = await bcrypt.compare(password, worker.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid password' });
    }
    // Fourth and last way into a worker account (bare login_id, no @). Same
    // block, same reason: every remaining door has to be shut or the covered FRO
    // simply walks in through whichever one was missed.
    if (!isHrFormLogin && String(worker.department || '').toLowerCase().trim() === 'fro') {
      const covered = await rejectIfCoveredFro(worker);
      if (covered) return res.status(403).json(covered);
    }
    const dept = (worker.department || '').toLowerCase().trim();
    if (dept === 'fro' && !isHrFormLogin) {
      await reconcileSessionHandover(worker.id);
    }
    let role;
    if (dept === 'hr') role = 'hr';
    else if (dept.includes('recruit')) role = 'recruiter';
    else if (dept === 'admin') role = 'accounts';
    else if (dept === 'fro') role = 'fro';
    else if (dept === 'ngo admin') role = 'admin';
    else if (dept === 'digital' || dept.includes('develop')) role = 'digital';
    else if (dept.includes('event')) role = 'event_head';
    else role = 'worker';
    // name is included because lead ownership falls back to a name match for rows
    // that carry no id (recruiterOwner() -> ownerName). The other three worker sign
    // sites already pass it; without it a recruiter logging in this way loses that
    // fallback for their token's whole lifetime.
    const token = jwt.sign(
      { id: worker.id, login_id: worker.login_id, ngo_id: worker.ngo_id, name: worker.name, role, department: worker.department },
      process.env.JWT_SECRET,
      signOptions
    );
    await recordCrmLogin(worker.id, worker.name, role, req.route?.path);
    return res.json({
      token,
      role,
      user: { id: worker.id, name: worker.name, email: worker.email, login_id: worker.login_id, ngo_id: worker.ngo_id, gender: worker.gender, dob: worker.dob, department: worker.department },
      message: 'Login successful',
    });
  } catch (error) {
    console.error('[LOGIN] Error:', error);
    return res.status(500).json({ message: 'Login failed', detail: error.message });
  }
};

// Super admin, NGO admin, or FRO may "work as" an FRO. The impersonated token
// keeps the operator's identity (imposter_id) so collection credit, accounts
// verification, and notifications follow the operator, while donor/assignment
// ownership follows the impersonated FRO (token id). Absconded / deactivated
// FROs (is_active=false, employment_status='absconded') remain coverable via
// work-as — direct login as the absconder stays blocked, but replacement FROs
// take over their stations through this flow.
export const impersonateFRO = async (req, res) => {
  try {
    // An agent may switch FROs like any operator: the switch endpoint on the
    // FRO panel is gated by a fresh single-use admin code, and the identity
    // handling below deliberately treats an agent's switch as a real cover
    // (operator = the agent's crm_agents id) rather than an impersonation of the
    // agent by the covered FRO. That part is what the old hard reject got wrong:
    // it believed the agent's heartbeat would file under the COVERED FRO and
    // credit the wrong person, but liveRowWorkerId already keys agent sessions
    // on the painted account — so a switched agent filing under the new target
    // is exactly the intended "this FRO is being worked" semantics.

    const { worker_id } = req.body;
    if (!worker_id) return res.status(400).json({ message: 'worker_id is required' });

    // workers.id is a UUID — never parseInt it (that would truncate ids like
    // "108a3f4e-..." to 108 and fail the uuid comparison in Postgres).
    const target = await getWorkerById(String(worker_id).trim());
    if (!target) return res.status(404).json({ message: 'Worker not found' });

    const targetDept = String(target.department || '').toLowerCase().trim();
    if (targetDept !== 'fro') {
      return res.status(400).json({ message: 'Only FRO workers can be impersonated' });
    }

    // Any staff role may work as any FRO (the list shows everyone): each switch
    // is gated by a fresh single-use admin-generated code below, which is the
    // real authorization. Deactivated / absconded FROs intentionally stay
    // selectable via work-as so another FRO can cover their stations; the
    // absconder's own login remains blocked (is_active=false).
    const operatorRole = req.user.role;
    if (!['fro', 'super_admin', 'master', 'admin', 'accounts', 'hr'].includes(operatorRole)) {
      return res.status(403).json({ message: 'Not allowed to impersonate an FRO' });
    }

    // "Who are you?" step: the operator optionally identifies which FRO worker
    // they are so credit goes to the correct person. When imposter_worker_id is
    // provided, validate it and use it as the imposter identity in the JWT.
    // A CHAINED switch (this operator is already impersonating someone) must
    // resolve the ORIGINAL operator, never the identity they are currently
    // painting. See resolveOperatorIdentity for why reading req.user.id/name
    // here was wrong.
    // Both are reassigned by the "Acting FRO worker" picker below, so they must
    // be let — not const — or that path throws at runtime.
    const identity = resolveOperatorIdentity(req.user);
    let imposterId = identity.imposterId;
    let imposterName = identity.imposterName;
    // An agent has no workers row — their identity lives in crm_agents — and the
    // agent login deliberately stamps impersonation:false, so resolveOperatorIdentity
    // above would hand back the PAINTED FRO as the operator. Every downstream step
    // here is keyed on the operator (releasing the previous cover, parking idle,
    // branding the covered FRO, and the reissued token's imposter_id), and all of
    // it must point at the agent's uuid, or a switched agent would be filed as the
    // FRO operating themselves: their old cover would survive, their idle would be
    // parked on the wrong row, and subsequent chained switches would release
    // somebody else's sessions.
    const agentSession = !!req.user?.agent_user_id;
    if (agentSession) {
      imposterId = String(req.user.agent_user_id);
      imposterName = String(req.user.agent_label || '');
    }
    // Resolve the operator's display name. New worker tokens carry it, but older
    // sessions / admin accounts may not — fall back to a DB lookup.
    if (!imposterName && imposterId != null) {
      const opWorker = await getWorkerById(String(imposterId));
      if (opWorker?.name) imposterName = opWorker.name;
      else {
        const opUser = await getUserById(imposterId);
        if (opUser?.name) imposterName = opUser.name;
      }
    }
    const { imposter_worker_id } = req.body;
    // The "who are you" picker lets a manual operator rename themselves; an agent
    // must not be renamed onto a workers row, so the body cannot override the
    // agent identity forced above. (The picker does not send it for agents today;
    // this just keeps a future caller from breaking the identity.)
    if (!agentSession && imposter_worker_id && String(imposter_worker_id) !== String(req.user.id)) {
      const imposterWorker = await getWorkerById(String(imposter_worker_id).trim());
      if (!imposterWorker) return res.status(404).json({ message: 'Acting FRO worker not found' });
      const impDept = String(imposterWorker.department || '').toLowerCase().trim();
      if (impDept !== 'fro') return res.status(400).json({ message: 'Acting FRO must be an FRO worker' });
      imposterId = imposterWorker.id;
      imposterName = imposterWorker.name || '';
    } else if (!agentSession && imposter_worker_id && String(imposter_worker_id) === String(req.user.id)) {
      // Picking yourself — use the JWT's existing identity, no worker validation needed.
    }

    // Work-as FRO requires a valid admin-generated 4-digit code (single use, 5-min expiry).
    const { code } = req.body;
    const codeStr = String(code || '').trim();
    if (!/^\d{4}$/.test(codeStr)) {
      return res.status(400).json({ message: 'A 4-digit code is required to impersonate an FRO' });
    }

    const codeRow = await findValidImpersonationCode(codeStr);
    if (!codeRow) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    // The code is consumed by the person at the keyboard. For an agent switch that
    // is the agent's uuid; req.user.id would name the covered FRO instead.
    const used = await markImpersonationCodeUsed(codeRow.id, agentSession ? imposterId : (req.user.id || null));
    if (!used) {
      return res.status(409).json({ message: 'Code was already used. Generate a new one.' });
    }

    // Reopen the target's CRM session: a work-as switch is an explicit
    // activation of the covered FRO's session. Without this, the heartbeat
    // force-logout guard (froController.updateLiveStatus) sees the target's
    // stale logged_out_at left by an earlier auto/manual logout and answers
    // 401 — bouncing the acting operator to /login the moment they finish the
    // switch. The login anchor becomes the switch time so the worked clock
    // starts from actual coverage; an existing same-day anchor is preserved so
    // hours the owner already put in today are not wiped.
    try {
      const now = new Date().toISOString();
      let loginAt = now;
      const existing = await sql('SELECT logged_in_at FROM auth_sessions WHERE user_id = $1', [String(target.id)]);
      if (existing?.[0]?.logged_in_at) {
        const sameIstDay = (a, b) =>
          new Date(new Date(a).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) ===
          new Date(new Date(b).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        if (sameIstDay(existing[0].logged_in_at, now)) loginAt = existing[0].logged_in_at;
      }
      await sql(
        `INSERT INTO auth_sessions (user_id, client, name, role, logged_in_at, last_active_at, logged_out_at)
         VALUES ($1, 'crm', $2, 'fro', $3, $4, NULL)
         ON CONFLICT (user_id)
         DO UPDATE SET name = $2, role = 'fro', logged_in_at = $3, last_active_at = $4, logged_out_at = NULL`,
        [String(target.id), target.name || null, loginAt, now]
      );
    } catch (e) {
      // auth_sessions may be absent until migration 125 — the switch still works.
    }

    // Station-scoped work-as: the operator picks which of the target's stations
    // they will work. Claimed pairs are locked for the session duration so
    // another operator acting as the same FRO cannot take them too. Omitted
    // stations field = unrestricted (legacy behaviour).
    let actStations = null;
    const rawStations = Array.isArray(req.body?.stations) ? req.body.stations : null;
    if (rawStations) {
      const { data: owned, error: ownErr } = await db
        .from('fro_station_assignments')
        .select('station, ngo_id')
        .eq('fro_worker_id', target.id);
      if (ownErr) throw ownErr;
      const ownedKeys = new Map((owned || []).map((a) => [`${a.ngo_id ?? ''}|${String(a.station).trim()}`, { ngo_id: a.ngo_id, station: a.station }]));
      if (ownedKeys.size === 0) {
        return res.status(400).json({ message: `${target.name} has no stations assigned to work on` });
      }

      let wantedPairs;
      if (rawStations.includes('all')) {
        wantedPairs = [...ownedKeys.values()];
      } else {
        wantedPairs = [];
        for (const r of rawStations) {
          // Strict shape check: rejects PowerShell/JSON-mangled entries like
          // "@{ngo_id=...;station=...}" that would otherwise poison the JWT
          // claim and silently blind the whole session.
          if (!r || typeof r !== 'object' || r.station == null) {
            return res.status(400).json({ message: 'Invalid stations payload: each entry must be {ngo_id, station}' });
          }
          const key = `${r.ngo_id ?? ''}|${String(r.station).trim()}`;
          if (!ownedKeys.has(key)) {
            return res.status(400).json({ message: `Station ${r.station} is not assigned to ${target.name}` });
          }
          wantedPairs.push(ownedKeys.get(key));
        }
      }

      // Switching targets frees this operator's previous work-as sessions first.
      // imposterId, not req.user.id: on a chained switch req.user.id is the FRO
      // being covered, so releasing against it wiped the COVERED FRO's sessions
      // and left the real operator's sessions running — which is how stale
      // work_as_sessions rows outlived their coverage.
      //
      // The display label goes with them. It lives on the target's own live row
      // and nothing else clears it: not a release, and not a switch to a new
      // target (which only brands the new one). Without this, switching from one
      // FRO to another left the first FRO's row still reading "being worked by
      // Priya" for as long as they stayed logged out — a cover that had ended but
      // still named, on the very board that is meant to say who is covering whom.
      await clearOperatorCoverLabels(imposterId);
      // Switching away ends those covers, so the targets' rows must be parked —
      // same reason as releaseWorkAs. Read before the release.
      const switchedTargets = await getActiveSessionTargets(imposterId).catch(() => []);
      await releaseOperatorSessions(imposterId);
      for (const targetId of switchedTargets) {
        await parkIdleState(targetId, { reason: 'cover_end', rearmGrace: true }).catch(() => {});
      }

      // Explicit take-over. The default is still to refuse (claimStations returns
      // the holders and we 409 below), because a station quietly changing hands is
      // how two people end up working the same list. This is the escape hatch for
      // the case where the conflict IS the problem: an agent has gone home or
      // fallen over, their cover is still holding every station, and the work has
      // to get done. Restricted to the admin-ish roles rather than to any FRO,
      // since an FRO evicting an agent is a 1:1 violation wearing a disguise.
      //
      // Only holders whose claimed pairs overlap the requested ones are displaced,
      // and only for THIS target — an operator legitimately covering a different
      // station of the same FRO keeps it.
      const TAKEOVER_ROLES = ['super_admin', 'master', 'admin', 'accounts', 'hr'];
      let displaced = [];
      if (req.body?.takeover === true && TAKEOVER_ROLES.includes(operatorRole)) {
        displaced = await releaseConflictingCovers({
          targetWorkerId: target.id,
          pairs: wantedPairs,
          keepOperatorId: imposterId,
        });
      }

      const claim = await claimStations({
        targetWorkerId: target.id,
        pairs: wantedPairs,
        operatorUserId: imposterId,
        operatorName: imposterName,
      });
      if (claim.conflict?.length > 0) {
        return res.status(409).json({
          message: 'Some selected stations are already being worked by others',
          conflicts: claim.conflict,
          // Tells the UI whether to offer "take over" rather than only "cancel".
          // Take-over is a real capability, not a hidden one, but it is only
          // offered to the roles allowed to perform it.
          takeover_allowed: TAKEOVER_ROLES.includes(operatorRole),
          ...(displaced.length > 0 ? { displaced } : {}),
        });
      }
      actStations = claim.ok;
    } else {
      // Unrestricted switch still supersedes any earlier scoped session, and
      // takes its display label with it.
      await clearOperatorCoverLabels(imposterId);
      const unscopedTargets = await getActiveSessionTargets(imposterId).catch(() => []);
      await releaseOperatorSessions(imposterId);
      for (const targetId of unscopedTargets) {
        await parkIdleState(targetId, { reason: 'cover_end', rearmGrace: true }).catch(() => {});
      }
    }

    // Park the operator's own open idle state before the switch begins.
    //
    // Their live row is about to stop receiving heartbeats, so any open period
    // or disposition deadline on it would be left behind. On return, the
    // deadline-derived fallback would backdate idle to whenever it lapsed —
    // charging the operator for the entire cover they spent demonstrably
    // working. Clearing it means they return to a clean row, and their idle
    // restarts from the first real action of the new session.
    await parkIdleForCoverStart(imposterId);
    await parkCoveredFRORow(target.id);

    // Author the cover relationship once, on the COVERED FRO's row, so the
    // admin boards can label it without the flicker that came from writing it
    // on every heartbeat (a person can be both covered and covering, and one
    // column cannot hold both). work_as_sessions remains the source of truth;
    // this is the display hint only.
    try {
      await db
        .from('fro_live_status')
        .update({ work_as_operator_id: String(imposterId), work_as_operator_name: imposterName || null })
        .eq('worker_id', String(target.id));
    } catch (e) {
      // Non-fatal: the label is cosmetic, the session row is what counts.
    }

    const tokenPayload = {
      id: target.id,
      login_id: target.login_id,
      ngo_id: target.ngo_id,
      role: 'fro',
      department: target.department || 'fro',
      name: target.name,
      impersonation: true,
      imposter_id: imposterId,
      imposter_name: imposterName,
      // An agent's identity must survive the switch: the heartbeat on the newly
      // covered FRO validates the agent, logout must release their cover, and
      // changing their password must hit the crm_agents branch. Dropping these
      // would silently turn a switched agent into a manual operator — an agent
      // uuid written into a workers-keyed live row would then fail the FK.
      ...(agentSession
        ? { agent_user_id: String(req.user.agent_user_id), agent_label: String(req.user.agent_label || '') }
        : {}),
    };
    if (actStations && actStations.length > 0) tokenPayload.act_stations = actStations;

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    const userPayload = {
      id: target.id,
      name: target.name,
      email: target.email,
      login_id: target.login_id,
      ngo_id: target.ngo_id,
      role: 'fro',
      department: target.department,
      impersonation: true,
      imposter_id: imposterId,
      imposter_name: imposterName,
      ...(agentSession
        ? { agent_user_id: String(req.user.agent_user_id), agent_label: String(req.user.agent_label || '') }
        : {}),
    };
    if (actStations && actStations.length > 0) userPayload.act_stations = actStations;

    return res.json({
      token,
      role: 'fro',
      user: userPayload,
      message: `Working as ${target.name}`,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// FROs the current user is allowed to impersonate (for the "Work as" picker).
// Every worker whose department normalises to 'fro' is listed — including
// deactivated ones, which the UI marks Inactive. btrim/lower matching so
// padded or differently-cased departments never hide a name. Every FRO is
// listed regardless of NGO or active status — each switch is individually
// authorized by a fresh admin-generated 4-digit code anyway.
export const getFroWorkersForImpersonation = async (req, res) => {
  try {
    // A covered FRO is listed by its agent label ("Agent 2"), so an admin can see
    // at a glance which accounts are spoken for before trying to work them.
    //
    // The label comes from crm_agents specifically, NOT from worker_aliases.
    // worker_aliases already holds 55 rows that are just lowercased spellings of
    // FRO names, and reading those as display labels would rewrite "Riddhi Patel"
    // to "riddhi patel" across the whole picker — a cosmetic regression across all
    // 53 FROs to fix 5 covered ones.
    const { rows, error } = await db._pool.query(
      `SELECT w.id, w.name, w.login_id, w.ngo_id, w.department, w.is_active, w.employment_status,
              COALESCE(ag.label, w.name) AS display_name,
              (ag.id IS NOT NULL) AS covered_by_agent,
              ag.label AS agent_label
         FROM workers w
         LEFT JOIN LATERAL (
           SELECT id, label
             FROM crm_agents
            WHERE worker_id = w.id AND is_active
            ORDER BY created_at DESC
            LIMIT 1
         ) ag ON TRUE
        WHERE ag.id IS NOT NULL
          AND lower(btrim(coalesce(w.department, ''))) = 'fro'
        ORDER BY ag.label ASC`
    );
    if (error) throw error;

    return res.json({ workers: (rows || []).filter((w) => String(w.id) !== String(req.user.id)) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Stations of the FRO the operator wants to work as, with live availability:
// which pairs are already claimed by other operators (and by whom). Powers the
// station picker in the Work As flow.
export const getFroWorkAsStations = async (req, res) => {
  try {
    const { workerId } = req.params;
    const target = await getWorkerById(String(workerId || '').trim());
    if (!target) return res.status(404).json({ message: 'Worker not found' });

    const targetDept = String(target.department || '').toLowerCase().trim();
    if (targetDept !== 'fro') {
      return res.status(400).json({ message: 'Only FRO workers can be worked as' });
    }

    const { data: assigns, error: aErr } = await db
      .from('fro_station_assignments')
      .select('station, ngo_id')
      .eq('fro_worker_id', target.id)
      .order('station', { ascending: true });
    if (aErr) throw aErr;

    let ngoNames = {};
    const ngoIds = [...new Set((assigns || []).map((a) => a.ngo_id).filter(Boolean))];
    if (ngoIds.length > 0) {
      const { data: ngos } = await db.from('ngos').select('id, name').in('id', ngoIds);
      for (const n of ngos || []) ngoNames[n.id] = n.name;
    }

    const sessions = await getActiveSessionsForTarget(target.id);
    const holderByKey = new Map();
    for (const s of sessions) {
      for (const st of s.stations || []) {
        holderByKey.set(`${st.ngo_id ?? ''}|${String(st.station ?? '').trim()}`, {
          taken_by: s.operator_name || 'another operator',
          mine: String(s.operator_user_id) === String(req.user.id),
        });
      }
    }

    const stations = (assigns || []).map((a) => {
      const key = `${a.ngo_id ?? ''}|${String(a.station).trim()}`;
      const holder = holderByKey.get(key) || null;
      return {
        station: a.station,
        ngo_id: a.ngo_id,
        ngo_name: ngoNames[a.ngo_id] || null,
        available: !holder,
        taken_by: holder?.taken_by || null,
        mine: holder?.mine || false,
      };
    });

    return res.json({
      stations,
      all_taken: stations.length > 0 && stations.every((s) => !s.available),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Park an operator's own live row at the moment a cover starts.
//
// Their row is about to go quiet, so anything time-derived sitting on it becomes
// a claim about a period they were not idle in. disposition_due_at is the
// dangerous one: with idle_since cleared, the deadline-derived fallback in
// liveIdleSeconds() would treat a lapsed deadline as "idle started then", so
// returning from a three-hour cover would bill three hours of idle to somebody
// who worked the whole time.
//
// today_idle_seconds is deliberately preserved — that is time genuinely banked
// before the switch. Only the open, undetermined state is cleared.
async function parkIdleForCoverStart(operatorId) {
  const id = String(operatorId ?? '');
  if (!id) return;
  try {
    await db
      .from('fro_live_status')
      .update({
        idle_since: null,
        disposition_due_at: null,
        current_donor_id: null,
        call_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('worker_id', id);
    // Close the authoritative interval at the moment the cover begins so the
    // operator's own ledger row is not billed while they work someone else's
    // queue. The next heartbeat after release re-opens it. Non-fatal.
    await closeOpenSession(id, { atMs: Date.now(), reason: 'cover_start' });
  } catch (e) {
    // Non-fatal: the freeze in froCoverFreeze still prevents billing a
    // covered-away FRO, and withoutStaleIdle() clears a same-day lapse on
    // the next hydrate.
  }
}

// Hand over from a previous session on this same account.
//
// A FRO who shuts one laptop and opens another is NOT idle in between: the old
// panel is gone, so there is nobody at the keyboard to be idle. But the previous
// session's interval and its lapsed disposition deadline survive on the one row
// the account has, and the hydrate path would then bill her from that deadline to
// this login — which is where a 45-minute "idle" appeared the moment she moved
// machines.
//
// So the interval is closed at the LAST EVIDENCE of presence (the row's own
// updated_at — the previous device's final heartbeat), never at login time, and
// the spent settle grace is cleared so she takes a fresh one. Skipped when her
// previous panel is still connected (a second tab), because that session is still
// live and must not be reset under her.
async function reconcileSessionHandover(workerId) {
  const id = String(workerId ?? '');
  if (!id) return { skipped: 'no_id' };
  try {
    const { data: row } = await db
      .from('fro_live_status')
      .select('updated_at')
      .eq('worker_id', id)
      .maybeSingle();
    if (!row) return { skipped: 'no_live_row' };

    const lastSeenMs = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
    const nowMs = Date.now();
    const plan = sessionHandoverPlan({
      panelStillLive: isWorkerOnline(id),
      lastSeenAtMs,
      nowMs,
      sameIstDay: Number.isFinite(lastSeenMs)
        ? istDateStr(new Date(lastSeenMs)) === istDateStr(new Date(nowMs))
        : null,
    });
    if (plan.skip) return { skipped: plan.skip };

    const r = await parkIdleState(id, {
      nowMs,
      closeAtMs: plan.closeAtMs,
      reason: 'session_handover',
      rearmGrace: true,
      clearCurrent: true,
    });
    return { parked: r.changed, lastSeen: new Date(plan.closeAtMs).toISOString() };
  } catch (e) {
    // Non-fatal: the worst case is the old billing, not a lost session.
    return { error: e?.message || String(e) };
  }
}

// Park a COVERED FRO's own row when they are not actually at their keyboard.
//
// While an agent covers them, the FRO's row stops receiving their own
// heartbeats. If its open interval and disposition deadline were left behind
// from a finished session, the deadline-derived fallback (and the idle sweep)
// would bill the FRO idle for the whole cover. The covering relation itself
// still sets the covered-away freeze, so with a closed interval the FRO reads
// as frozen, not as billed idle.
//
// Guarded so a LIVE FRO — row fresh and active — keeps their running window:
// they are at their desk on their own panel, and only their own heartbeats
// should shape that row. If they prove otherwise by going stale later, the
// ordinary covered-away freeze takes over.
async function parkCoveredFRORow(workerId) {
  const id = String(workerId ?? '');
  if (!id) return;
  try {
    const { data: row } = await db
      .from('fro_live_status')
      .select('status, updated_at')
      .eq('worker_id', id)
      .maybeSingle();
    if (!row) return;
    const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
    const fresh = Number.isFinite(updatedMs) && (Date.now() - updatedMs) < 120000;
    const active = row.status && row.status !== 'offline' && row.status !== 'idle';
    if (fresh && active) return;
    await parkIdleForCoverStart(id);
  } catch (e) {
    // Non-fatal: worst case the covered-away freeze keeps the row dormant.
  }
}

// Release every active work-as session the caller holds (Exit work-as button).
export const releaseWorkAs = async (req, res) => {
  try {
    const operatorId = req.user.impersonation && req.user.imposter_id ? req.user.imposter_id : req.user.id;
    // Clear the display label on every row this operator was covering, not just
    // the one currently painted on their token.
    //
    // Keying off req.user.id only ever cleared the CURRENT target, so a badge
    // survived on any earlier target the operator had switched away from — the
    // label outlived the cover that created it. Read the operator's own sessions
    // and unbrand all of them, then release.
    //
    // The caller's painted id is still cleared afterwards as a belt-and-braces
    // pass: it is what the token says they were working, and it is a no-op when
    // the helper already handled it.
    // Unbrand every target this operator was covering BEFORE releasing. The helper
    // reads their active sessions to find those targets, so it has to run first —
    // after release there is nothing left to enumerate.
    await clearOperatorCoverLabels(operatorId);
    // Park every FRO this operator was covering as the cover ends. Their rows stop
    // being refreshed at this moment and the covered-away freeze stops applying
    // the instant the session is released, so an interval left open here would
    // keep billing idle to somebody who was never at their desk. Read the targets
    // BEFORE releasing — afterwards there is nothing left to enumerate.
    const endingTargets = await getActiveSessionTargets(operatorId).catch(() => []);
    const released = await releaseOperatorSessions(operatorId);
    for (const targetId of endingTargets) {
      await parkIdleState(targetId, { reason: 'cover_end', rearmGrace: true }).catch(() => {});
    }
    // The caller's painted id is cleared afterwards as a belt-and-braces pass: it
    // is what the token says they were working, and it is a no-op when the helper
    // already handled it.
    const targetId = req.user.impersonation ? String(req.user.id) : null;
    if (targetId) {
      try {
        await db
          .from('fro_live_status')
          .update({ work_as_operator_id: null, work_as_operator_name: null })
          .eq('worker_id', targetId)
          .eq('work_as_operator_id', String(operatorId));
      } catch (e) {
        // Non-fatal: cosmetic label only.
      }
    }

    // An agent ending a work-as cover returns to their OWN assigned FRO. While
    // impersonating, req.user.id is the covered FRO, and the switch released the
    // agent's sessions outright — so the assigned FRO's cover must be re-claimed
    // here. The heartbeat never recreates a claim (refreshCoverExpiry only pushes
    // an existing expiry forward), so without this an agent who exits work-as
    // leaves their assigned FRO uncovered: idle would accrue while they work, and
    // their stations would become claimable by anyone.
    if (req.user?.agent_user_id && req.user.impersonation && req.user.id != null) {
      try {
        const opAgent = await getAgentById(String(req.user.agent_user_id));
        const assignedFroId = opAgent?.worker_id;
        if (assignedFroId && String(assignedFroId) !== String(req.user.id)) {
          const { data: owned } = await db
            .from('fro_station_assignments')
            .select('station, ngo_id')
            .eq('fro_worker_id', String(assignedFroId));
          if (owned?.length) {
            const opName = req.user.agent_label || opAgent?.label || null;
            // Best-effort: someone else may cover the assigned FRO by now, in
            // which case claimStations returns conflicts rather than throwing,
            // and the agent's own session still works without the claim.
            await claimStations({
              targetWorkerId: String(assignedFroId),
              pairs: owned,
              operatorUserId: String(req.user.agent_user_id),
              operatorName: opName,
            });
            await db
              .from('fro_live_status')
              .update({
                work_as_operator_id: String(req.user.agent_user_id),
                work_as_operator_name: opName,
              })
              .eq('worker_id', String(assignedFroId));
          }
        }
      } catch (e) {
        console.warn('[auth] agent cover restore on exit failed:', e?.message || String(e));
      }
    }

    return res.json({ message: 'Work-as sessions released', released });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// POST /auth/change-password  { currentPassword, newPassword }
// Lets any DB-backed user (worker | users | hrs) change their own password by
// confirming the current one. Super admin (env-based) and the env 'user' have no
// DB row, so they are rejected — their credentials are managed elsewhere.
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    // Super admin & env user have no DB-backed identity to update.
    if (req.user.role === 'super_admin' || req.user.id == null || req.user.id === -1 || req.user.id === 0) {
      return res.status(403).json({ message: 'Password change is not supported for this account.' });
    }

    // An agent must be handled before the resolution below, and it is not a
    // stylistic preference.
    //
    // An agent's token deliberately carries the ASSIGNED FRO's id and login_id,
    // because that is what makes every FRO screen work for them. The generic path
    // reads exactly those two fields, finds that worker, and rewrites the FRO's
    // password. The result is an agent able to lock the FRO out of their own
    // account with no admin action that could undo it, and an FRO whose working
    // password silently stopped working. So agents authenticate against
    // crm_agents, which is where their credential actually lives.
    if (req.user.agent_user_id) {
      const agent = await getAgentById(req.user.agent_user_id);
      if (!agent) return res.status(404).json({ message: 'Account not found.' });
      const creds = await getAgentByLoginId(agent.login_id);
      if (!creds) return res.status(404).json({ message: 'Account not found.' });
      const agentMatch = await bcrypt.compare(String(currentPassword), creds.password_hash);
      if (!agentMatch) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }
      const agentSalt = await bcrypt.genSalt(10);
      await setAgentPasswordHash(String(agent.id), await bcrypt.hash(String(newPassword), agentSalt));
      return res.json({ message: 'Password changed successfully' });
    }

    let source = null; // { id, table, passwordColumn, currentHash }
    if (req.user.login_id) {
      // Operators (Beneficiaries app) live in bnf_operators — check there first,
      // then fall back to the workers table.
      const bnfOp = await getBnfOperatorByLoginId(req.user.login_id) || await getBnfOperatorById(req.user.id);
      if (bnfOp) {
        source = { id: bnfOp.id, update: (h) => updateBnfOperator(bnfOp.id, { password: h }), currentHash: bnfOp.password };
      } else {
        const worker = await getWorkerByLoginId(req.user.login_id) || await getWorkerById(req.user.id);
        if (worker) source = { id: worker.id, update: (h) => updateWorker(worker.id, { password: h }), currentHash: worker.password };
      }
    } else if (req.user.role === 'hr') {
      const hr = await getHRById(req.user.id) || await getHRByEmail(req.user.email);
      if (hr) source = { id: hr.id, update: (h) => updateHR(hr.id, { password_hash: h }), currentHash: hr.password_hash };
    } else {
      const user = await getUserById(req.user.id) || await getUserByEmail(req.user.email);
      if (user) source = { id: user.id, update: (h) => updateUser(user.id, { password_hash: h }), currentHash: user.password_hash };
    }

    if (!source) {
      return res.status(404).json({ message: 'Account not found.' });
    }

    const isMatch = await bcrypt.compare(currentPassword, source.currentHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(newPassword, salt);
    await source.update(hashed);

    return res.json({ message: 'Password changed successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
