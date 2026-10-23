// Small word lists used to keep the name/organization detectors from firing on ordinary words.

const w = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/** Never a person name on its own (function words, greetings, roles, calendar words). */
export const FUNC_STOP = w(`
  everyone everybody anyone someone all there here team guys folks colleagues friends sir madam customer client user users admin administrator
  support sales hello hi hey dear thanks thank regards best cheers sincerely greetings team staff management office service services
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december
  januar februar märz mai juni juli oktober dezember janvier février mars avril juin juillet août septembre octobre novembre décembre
  enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre gennaio febbraio aprile maggio giugno luglio settembre ottobre dicembre
  the and for with from this that these those our your please attn attention regarding subject re fw fwd
  alle zusammen liebe herr frau team kunde kunden bonjour madame monsieur equipo estimados todos tutti
`);

/** Names that are also everyday words: only accepted when a strong cue says "this is a person". */
export const COMMON = w(`
  will may mark rose hope faith joy grace summer autumn april june august dawn ivy jack jan jean pat art rob sue grant king young white black green brown
  gray grey stone wood hill field lane fox wolf bird bell cook baker miller carter porter mason hunter archer fisher shepherd knight bishop page price long
  short small little strong sweet wise rich love heart angel happy sunny paris london georgia virginia ruby amber crystal pearl jade violet lily daisy holly
  olive hazel willow christian bill bob buck chase chip clay dean duke earl guy heath hunt jet kit lee max miles nick pierce pat peace pen rex rich ross
  sage skip star tag tom toy trace west north east south wells wells ward warren webb wise woods wright young drew dale dell dawn bay bishop brook brooks
  cross day dunn flowers forest frost gill hall hart hay holt hood hull jordan kent knox lamb lance law lewis lord mann marsh may moon moore mott nash noble
  nunn paine park parks pope pratt reed rice rider rivers roe rush salt sands sharp shaw snow spring steel strange swift sykes tate thorn todd tower vale
  vance wade walker wall wells wild winter wolfe wren
`);

/** Words that start sentences or open phrases before organization names. */
export const ORG_LEAD_STOP = w(`
  the a an our your my this that these those please contact visit call from to at in on dear hi hello thanks customer client company supplier vendor partner
  between and with for of by via see attn attention regarding re subject employer owner buyer seller licensor licensee parties agreement signed sent
  we us they he she it is are was were be been mr mrs ms miss dr prof herr frau sir madam
  copyright present c all rights reserved licensed under powered made built maintained sponsored developed designed published
  trademark trademarks registered owned operated provided brought presented
`);

export const ROLE_LOCALS = w(`
  info support sales admin administrator noreply no-reply donotreply contact billing accounting team hello office service help jobs hr mail
  postmaster webmaster abuse security privacy legal marketing press media news newsletter orders order invoice invoices finance it ops
  devops dev root user test demo example
`);

export const GENERIC_USERS = w(`
  public default all users shared administrator admin guest user ubuntu ec2-user runner vagrant root deploy www-data nobody docker jenkins ci build builder
  tester test sandbox you username yourname me name example someone appuser service svc
`);
