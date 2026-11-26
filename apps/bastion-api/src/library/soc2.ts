// SOC 2 Trust Services Criteria, common criteria (CC1 to CC9), as a framework template.
//
// The reference codes are the public criterion numbers so an auditor can find their place.
// Every title and plain_summary is our own plain-language description written for this
// product; none of it is the official AICPA wording. control_keys point into controls.ts; a key
// that also appears in iso27001.ts makes the two requirements share one control (the static
// crosswalk, spec 2.1).

import type { FrameworkTemplate } from './types.js';

export const SOC2: FrameworkTemplate = {
  template_key: 'soc2',
  template_version: '2017-rev2022.1',
  name: 'SOC 2',
  is_iso: false,
  description: 'The security criteria a SOC 2 auditor checks, grouped the way the auditor\'s report is.',
  requirements: [
    // CC1 Control environment
    { ref_code: 'CC1.1', title: 'Integrity and ethical values', plain_summary: 'The company shows it values honesty, and staff agree to a code of conduct.', control_keys: ['hr.terms_and_nda'] },
    { ref_code: 'CC1.2', title: 'Oversight by leadership', plain_summary: 'People independent of day-to-day work oversee how security is run.', control_keys: ['governance.leadership_oversight'] },
    { ref_code: 'CC1.3', title: 'Structure and responsibilities', plain_summary: 'Reporting lines and responsibilities for security are set and written down.', control_keys: ['governance.org_structure'] },
    { ref_code: 'CC1.4', title: 'Competent people', plain_summary: 'The company checks, trains and keeps people able to do their security duties.', control_keys: ['hr.screening', 'hr.training'] },
    { ref_code: 'CC1.5', title: 'Accountability', plain_summary: 'People are held responsible for their part in security.', control_keys: ['hr.disciplinary', 'governance.org_structure'] },
    // CC2 Communication and information
    { ref_code: 'CC2.1', title: 'Useful information', plain_summary: 'The company keeps accurate information about its systems and data to run its controls.', control_keys: ['assets.inventory', 'data.classification'] },
    { ref_code: 'CC2.2', title: 'Communicating inside the company', plain_summary: 'Security goals and duties are explained to the people who need them.', control_keys: ['policy.security_policy', 'hr.training'] },
    { ref_code: 'CC2.3', title: 'Communicating with outsiders', plain_summary: 'Customers, suppliers and others are told what they need to know about security, and can report problems.', control_keys: ['communication.external'] },
    // CC3 Risk assessment
    { ref_code: 'CC3.1', title: 'Clear objectives', plain_summary: 'Security goals are clear enough that risks to them can be found.', control_keys: ['governance.security_program'] },
    { ref_code: 'CC3.2', title: 'Finding and weighing risks', plain_summary: 'Risks, including those from suppliers, are found and weighed.', control_keys: ['risk.assessment', 'vendors.management'] },
    { ref_code: 'CC3.3', title: 'Fraud risk', plain_summary: 'The chance of fraud is considered when weighing risks.', control_keys: ['risk.assessment'] },
    { ref_code: 'CC3.4', title: 'Changes that affect controls', plain_summary: 'Big changes in the business or its systems are checked for new risks.', control_keys: ['risk.assessment', 'projects.security'] },
    // CC4 Monitoring activities
    { ref_code: 'CC4.1', title: 'Checking controls work', plain_summary: 'Controls are checked regularly, by ongoing monitoring or separate reviews.', control_keys: ['compliance.independent_review', 'logging.audit_trail'] },
    { ref_code: 'CC4.2', title: 'Reporting control problems', plain_summary: 'Problems found in controls reach the people who can fix them, in time.', control_keys: ['compliance.independent_review'] },
    // CC5 Control activities
    { ref_code: 'CC5.1', title: 'Controls that reduce risk', plain_summary: 'Controls are chosen to bring risks down to an acceptable level.', control_keys: ['governance.security_program'] },
    { ref_code: 'CC5.2', title: 'Controls over technology', plain_summary: 'General controls over technology, such as standard setups and reliable automation, are in place.', control_keys: ['automation.reliability', 'config.baseline'] },
    { ref_code: 'CC5.3', title: 'Policies and procedures', plain_summary: 'Controls are set out in policies and put into practice through procedures.', control_keys: ['policy.security_policy'] },
    // CC6 Logical and physical access
    { ref_code: 'CC6.1', title: 'Protecting access to systems', plain_summary: 'Systems and data are protected by sign-in controls, limited rights, managed keys, encryption and a list of what exists.', control_keys: ['auth.mfa', 'access.least_privilege', 'keys.rotation', 'assets.inventory', 'data.encryption'] },
    { ref_code: 'CC6.2', title: 'Adding and removing users', plain_summary: 'People get accounts only after approval, and lose them when they no longer need them.', control_keys: ['access.provisioning', 'access.offboarding'] },
    { ref_code: 'CC6.3', title: 'Right-sized access', plain_summary: 'Access matches each role, is reviewed, and is changed or removed when roles change, for people and agents alike.', control_keys: ['access.reviews', 'access.least_privilege', 'agents.oversight', 'platform.superuser_oversight', 'access.offboarding'] },
    { ref_code: 'CC6.4', title: 'Physical access', plain_summary: 'Physical access to buildings and equipment is limited to the right people.', control_keys: ['physical.premises', 'physical.workspace'] },
    { ref_code: 'CC6.5', title: 'Disposing of equipment', plain_summary: 'Data is wiped before devices and storage are thrown away or reused.', control_keys: ['assets.media_disposal'] },
    { ref_code: 'CC6.6', title: 'Protecting the edges', plain_summary: 'Systems are protected against threats from outside the company network.', control_keys: ['network.security', 'access.remote_work'] },
    { ref_code: 'CC6.7', title: 'Protecting data on the move', plain_summary: 'Data is protected when it is sent or carried, including on laptops.', control_keys: ['data.encryption', 'assets.device_encryption'] },
    { ref_code: 'CC6.8', title: 'Stopping harmful software', plain_summary: 'Harmful or unapproved software is prevented or caught.', control_keys: ['assets.endpoint_protection', 'config.baseline'] },
    // CC7 System operations
    { ref_code: 'CC7.1', title: 'Finding weaknesses and setup changes', plain_summary: 'Weaknesses and unexpected setup changes are found and looked at.', control_keys: ['vuln.management', 'config.baseline', 'threat.intelligence'] },
    { ref_code: 'CC7.2', title: 'Watching for unusual activity', plain_summary: 'Systems are watched for unusual activity that may signal an attack or failure.', control_keys: ['ops.monitoring', 'auth.login_monitoring', 'logging.retention', 'logging.audit_trail'] },
    { ref_code: 'CC7.3', title: 'Judging security events', plain_summary: 'Security events are assessed to decide whether they are incidents.', control_keys: ['incident.response'] },
    { ref_code: 'CC7.4', title: 'Responding to incidents', plain_summary: 'Incidents are handled through a known response process.', control_keys: ['incident.response'] },
    { ref_code: 'CC7.5', title: 'Recovering from incidents', plain_summary: 'After an incident, systems and data are brought back, using tested backups where needed.', control_keys: ['incident.response', 'ops.backups', 'ops.restore_testing', 'bcp.continuity'] },
    // CC8 Change management
    { ref_code: 'CC8.1', title: 'Managing changes', plain_summary: 'Changes to systems and code are planned, reviewed, tested and approved before going live.', control_keys: ['change.peer_review', 'change.traceability', 'dev.secure_development'] },
    // CC9 Risk mitigation
    { ref_code: 'CC9.1', title: 'Business disruption', plain_summary: 'The company prepares for events that could disrupt the business.', control_keys: ['bcp.continuity'] },
    { ref_code: 'CC9.2', title: 'Supplier and partner risk', plain_summary: 'Risks from suppliers and business partners are assessed and managed.', control_keys: ['vendors.management'] },
  ],
};
