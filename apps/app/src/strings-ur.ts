/**
 * Every word the app's chrome says, in Roman Urdu.
 *
 * FIRST DRAFT — the wording here is unvalidated and WILL be corrected with
 * pilot techs (docs/assumptions.md #8 roman-urdu, #9 literacy). The register
 * aimed for is how Lahore actually types on WhatsApp, not transliterated
 * formal Urdu: English loanwords stay where the trade uses them (scan, case,
 * camera, print, job, label, shelf, late, photo), product and tech terms stay
 * verbatim, and numbers, units and codes are untouched. When a tech reads a
 * line out loud and it sounds like a textbook, that line is wrong.
 *
 * THE SHAPE IS THE CONTRACT. The `StrTable` annotation makes this table a
 * compile error the moment it drifts from strings.ts — a missing key, an
 * extra key, or a function with the wrong arity fails `npm run typecheck`,
 * and test/strings-ur.test.mjs re-proves it at runtime with sample args.
 *
 * Urdu pluralises differently from English ('cheez' → 'cheezein', loanwords
 * usually flat: '3 photos' but '2 din'), so the parameterised entries carry
 * their own plural logic instead of borrowing the English `s()` helper.
 */
import type { StrTable } from './strings.ts'

/** 'cheez'/'cheezein' — the noun most counters count, named once. */
const cheezein = (n: number): string => (n === 1 ? 'cheez' : 'cheezein')

/**
 * The ledger's row vocabulary — same lookup shape as the English table's
 * KIND_EN, fallback the raw kind, never a blank row. 'late fee' stays the
 * loanword the trade already uses.
 */
const KIND_UR: Record<string, string> = {
  charge: 'kiraya',
  payment: 'wusooli',
  deposit_hold: 'zamanat rakhi',
  deposit_apply: 'zamanat lagi',
  deposit_refund: 'zamanat wapas',
  late_fee: 'late fee',
  damage_charge: 'nuqsaan',
  adjustment: 'darusti',
  // Correction vocabulary: 'mansookh' (voided) for a reversal — a bounced
  // cheque must never read as the house's own 'darusti' — and 'write off'
  // stays the loanword the trade uses, like 'late fee'.
  reversal: 'mansookh',
  write_off: 'write off',
}

/**
 * The expense book's row vocabulary (0019) — 'marammat' for a repair,
 * loanwords where the trade uses them (sub-hire, transport).
 */
/** Overdue ladder ke rung — us din ka kaam. */
const ESCALATION_UR: Record<string, string> = {
  whatsapp_nudge: 'pehla nudge',
  call: 'call karo',
  late_fee_draft: 'late fee lagao',
  manager_escalation: 'manager ke paas',
}

const KHARCHA_UR: Record<string, string> = {
  repair: 'marammat',
  sub_hire: 'sub-hire',
  purchase: 'khareedari',
  transport: 'transport',
  consumables: 'chhota saman',
  misc: 'deegar',
}


/** The outbox op vocabulary for the attention cards — same shape as OP_EN. */
const OP_UR: Record<string, string> = {
  submit_scan_batch: 'ek scan',
  void_scan: 'scan wapas lena',
  bind_tag: 'label lagana',
  create_booking: 'nayi booking',
  confirm_booking: 'booking confirm karna',
  cancel_booking: 'booking cancel karna',
  extend_booking: 'booking barhana',
  reallocate_reservation: 'promised unit badalna',
  convert_booking_to_job: 'booking ko job banana',
  upsert_partner_house: 'partner house',
  remove_partner_house: 'partner house hatana',
  record_sub_hire_in: 'udhaar liya unit',
  record_sub_hire_out: 'udhaar diya unit',
  close_sub_hire: 'sub-hire ki wapsi',
  assign_attendant: 'crew',
  unassign_attendant: 'crew',
  upsert_rate_card: 'rate card',
  upsert_rate_entry: 'ek rate',
  set_calendar_day: 'calendar ka din',
  clear_calendar_day: 'calendar ka din',
  set_line_rate_override: 'rate override',
  create_customer: 'naya customer',
  create_job: 'walk-in job',
  close_job: 'job band karna',
  reopen_job: 'job dobara kholna',
  set_job_expected_back: 'wapsi ki tareekh',
  set_booking_note: 'booking ka note',
  record_payment: 'mili hui payment',
  record_ledger_entry: 'khata ki line',
  record_expense: 'kharcha ki entry',
  reverse_expense: 'kharcha entry wapas lena',
}

export const STR_UR: StrTable = {
  // ---------------------------------------------------------------- common
  commonTabToday: 'Aaj',
  commonTabGear: 'Saaman',
  commonTabDesk: 'Desk',
  commonTabKhata: 'Khata',
  commonSettings: 'Settings',
  commonSettingsSubtitle: 'Zubaan, labels, backup, paisa lena',
  commonOpenSettingsAria: 'Settings kholo',
  commonNavMainAria: 'Main',
  commonDbWouldNotStart: 'Local database chal nahi saki.',
  commonOpeningWarehouse: 'Warehouse khul raha hai…',
  commonClose: 'Band karein',
  commonBackToToday: 'Wapas aaj par',
  commonUnknownItem: 'Anjaan cheez',
  commonItemsStillOut: (n: number): string =>
    `${n} ${cheezein(n)} abhi bahar`,
  commonPressAndHoldAria: (label: string): string =>
    `${label} — dabaye rakhein`,
  commonAppName: 'Papa Vendor',
  commonLanguage: 'Zubaan',
  commonLanguageEnglish: 'English',
  commonLanguageRomanUrdu: 'Roman Urdu',
  commonLanguageSub: 'Aik baar chuno — app usi zubaan mein dobara khulti hai',

  // ---------------------------------------------------------------- today
  todaySearchGearAria: 'Saaman dhoondein',
  todayStatOutNow: 'abhi bahar',
  todayStatOnTheShelf: 'shelf par',
  todayStatOverdue: 'late',
  todayStatNeedALook: 'dekhna hai',
  todayGoingOutToday: 'Aaj ka nikalna',
  todayNothingScheduled: 'Kuch scheduled nahi',
  todayJobsPacked: (jobs: number, scanned: number, expected: number): string =>
    `${jobs} job · ${expected} mein se ${scanned} pack ho gaye`,
  todayNewJob: 'Nayi job',
  todayNothingScheduledToday: 'Aaj kuch scheduled nahi.',
  todayStartAJob:
    'Job shuru kar ke saaman scan out karein, ya kuch bhi scan kar ke dekhein kahan hai.',
  todayJustScan: 'Bas scan karein',
  todayPacked: 'Pack ho gaya',
  todayInProgress: 'Chal rahi hai',
  todayLastHandover: 'Aakhri handover',
  todayComingBack: 'Wapas aa raha hai',
  todayTapOneToBookBack: 'Kisi par tap karein, uska saaman wapas book karein',
  todayNudgeOnWhatsApp: 'WhatsApp par yaad dilayein',
  todayQuick: 'Fatafat',
  todayWhereIsThisThing: 'Yeh cheez kahan hai?',
  todayDinKaHisaab: 'Din ka hisaab',
  todayWhatMovedToday: 'Aaj kya gaya, kya aaya',
  todayLoadYourGear: 'Apna saaman load karein',
  todayPasteAListFromExcel: 'Excel se list paste karein',
  todayAnswerAKitList: 'Kit list ka jawab dein',
  todayPasteFromWhatsApp: 'WhatsApp se paste karein',
  todayAllTheGear: 'Saara saaman',
  todaySearchByNameOrCode: 'Naam ya code se dhoondein',
  todayCall: 'Call',
  todayCallAria: (contact: string): string => `${contact} ko call karein`,
  todayWhatsApp: 'WhatsApp',
  todayWhatsAppAria: (contact: string): string => `${contact} ko WhatsApp karein`,
  todayChangeDate: 'Date badlein',
  todaySetADate: 'Date lagayein',
  todayExpectedBack: 'Wapsi',
  todayExpectedBackDateAria: 'Wapsi ki date',
  todayCurrentlyANote: (note: string): string =>
    `Abhi ek note hai: “${note}”. Date chunne se yeh hat jayega.`,
  todayClearDate: 'Date hatayein',
  todaySave: 'Save karein',
  todayWhatIsTheJob: 'Job kya hai?',
  todayJobLabelPlaceholder: 'maslan Music video — Gulberg',
  todayContactOptional: 'Contact (zaroori nahi)',
  todayContactPlaceholder: 'Naam aur number — maslan Bilal 0300 4412233',
  todayExpectedBackOptional: 'Wapsi (zaroori nahi)',
  todayCreateJob: 'Job banayein',
  todayCustomerOptional: 'Customer (zaroori nahi)',
  todayNoCustomer: 'Koi customer nahi',
  todayNoCustomerHint: 'Customer ke baghair is job par charge nahi likha ja sakta.',
  todayNewCustomer: 'Naya customer',
  todayCustomerNameLabel: 'Customer ka naam',
  todayCustomerNamePlaceholder: 'maslan Bilal Hussain',
  todayCustomerPhoneOptional: 'Phone (zaroori nahi)',
  todayOpenKhataAria: (name: string): string => `${name} ka khata kholein`,
  todayCloseJob: 'Job band karein',
  todayStillOutCannotClose: (n: number): string =>
    n === 1 ? '1 cheez abhi bahar hai' : `${n} cheezein abhi bahar hain`,
  todayMoneyHeading: 'Paisa',
  todayMoneyOwedToMe: 'mera udhaar',
  todayMoneyDueInToday: 'aaj aana hai',
  todayMoneyEarnedThisMonth: 'is mahine kamaya',
  todayMoneyOwedAria: 'Mera udhaar — list kholein',

  // ----------------------------------------------------------------- scan
  scanGoingOut: 'Bahar ja raha hai',
  scanComingBack: 'Wapas aa raha hai',
  scanLooseScan: 'Loose scan',
  scanThisItem: 'yeh cheez',
  scanPhotographAria: (name: string): string => `${name} ki photo lein`,
  scanAddAnyway: 'Phir bhi add karein',
  scanNotThisJob: 'Is job ka nahi',
  scanAttachThisLabel: 'Yeh label lagayein',
  scanTorchOffAria: 'Torch band karein',
  scanTorchOnAria: 'Torch jalayein',
  scanListAsOf: (age: string): string =>
    `List ${age} purani hai · refresh nahi hui`,
  scanCantScanIt: 'Scan nahi ho raha',
  scanHoldToFinishLeft: (remaining: number): string =>
    `Khatam karne ke liye dabaye rakhein · ${remaining} baqi`,
  scanHoldToFinish: 'Khatam karne ke liye dabaye rakhein',
  scanAddedToThisJob: 'Is job mein add ho gaya',
  scanLeftOffThisJob: 'Is job se nikal diya',
  scanDeviceFull: (waiting: number): string =>
    `Phone full hai — ${waiting} photo abhi bhejni baqi ${waiting === 1 ? 'hai' : 'hain'}. ` +
    'Kuch delete nahi hua. Phone ko online karein, phir dobara koshish karein.',
  scanGotIt: 'Theek hai',
  scanWhatIsThisLabelOn: 'Yeh label kis cheez par hai?',
  scanDocTitle: (jobLabel: string): string => `${jobLabel} — Papa Vendor`,
  scanLookupDocTitle: 'Yeh cheez kahan hai? — Papa Vendor',
  scanLabelReportedLost: 'Yeh label gum report hua tha — kuch record nahi hua',
  scanLabelRetired: 'Yeh label retire ho chuka hai — kuch record nahi hua',
  scanNotOnThisPhoneYet: 'Abhi is phone par nahi hai — kuch record nahi hua',
  scanUnknownLabel: 'Anjaan label — kuch record nahi hua',
  scanOnlyLooking: 'Sirf dekh rahe hain — kuch record nahi hota',
  scanManualPlaceholder: 'Code ya naam — maslan FX9 ya Aputure',
  scanTypeAFewLetters: 'Code ya naam ke chand harf likhein.',
  scanNothingMatchesQuery: (query: string): string =>
    `“${query}” se kuch match nahi hua.`,
  scanDeskDecoder: 'Desk decoder',
  scanStartingCamera: 'Camera shuru ho raha hai…',
  scanNeedsSecurePageOpenOn: 'Camera ko secure page chahiye. Isko kholein:',
  scanOrStartTheServerWith: ', ya server aise chalayein:',
  scanPermissionRefused: 'Camera ki ijazat nahi mili. Allow kar ke reload karein.',
  scanCameraWouldNotStart: 'Camera chala nahi.',
  scanPhotoSecurePage:
    'Camera ko secure page chahiye — localhost ya https par kholein.',
  scanPhotoNotEncoded: 'Photo ban nahi saki.',
  scanPhotoNotReadBack: 'Photo dobara khul nahi saki.',
  scanHowItLooksGoingOut: 'Jaate waqt kaisi lag rahi hai',
  scanHowItCameBack: 'Wapsi par kaisi aayi',
  scanSaving: 'Save ho raha hai…',
  scanTakeThePhoto: 'Photo lein',
  scanTimedByThisPhone:
    'Waqt is phone ki clock ka hai. Server pahunchne par apna waqt lagata hai.',
  scanWhatIsInThisCase: 'Is case mein kya hai',
  scanCaseFallback: 'Case',
  scanBelievedInside: (n: number): string =>
    `andar ${n} ${cheezein(n)} honi ${n === 1 ? 'chahiye' : 'chahiyein'}`,
  scanPartOfTheCase: 'Case ka hissa',
  scanCannotLeaveWithoutIt:
    'Yeh iske baghair nahi ja sakteen, isliye case ke saath record hoti hain.',
  scanPackedInside: 'Andar packed — dekha nahi gaya',
  scanThemOneByOne: 'Ek ek kar ke scan karein',
  scanTakeTheRestAsPacked: (unchecked: number): string =>
    `Baqi packed maan lein · ${unchecked} check nahi hue`,
  scanTakeTheCaseAsPacked: (unchecked: number): string =>
    `Poora case packed maan lein · ${unchecked} check nahi hue`,
  scanTakingAsPackedRecords: 'Packed maan lene se woh items record hoti hain',
  scanAssumedWord: 'assumed',
  scanCountedSeparately:
    ' ke tor par. Inki ginti alag hoti hai, aur agar is job par damage ka jhagra hua to yeh saboot nahi banteen.',
  scanMarkedNotInHere: (excluded: number): string =>
    `${excluded === 1 ? 'Ek cheez' : `${excluded} cheezein`} “isme nahi hai” mark hui — ` +
    'uska koi record nahi banega, aur handover par missing dikhegi.',
  scanUnnamed: 'Bina naam',
  scanItIsHere: 'Yeh yahan hai',
  scanNotInHere: 'Isme nahi hai',

  // -------------------------------------------------------------- session
  sessionHandover: 'Handover',
  sessionNothingOpen: 'Kuch khula nahi',
  sessionNothingScannedYet: 'Is job par abhi kuch scan nahi hua.',
  sessionScanAndItWillBeHere:
    'Saaman scan out ya wapas karein — handover ka khulasa yahan aayega. Puri hui sessions job card se dobara dekhi ja sakti hain.',
  sessionItems: 'cheezein',
  sessionBack: 'wapas',
  sessionScanned: 'scan hue',
  sessionByCase: 'case se',
  sessionStillOut: 'abhi bahar',
  sessionNotAccountedFor: 'hisaab mein nahi',
  sessionEverythingCameBack: 'Jo bahar gaya tha, sab wapas aa gaya.',
  sessionEverythingAccountedFor: 'List ki har cheez ka hisaab poora hai.',
  sessionWorthACall: 'Ya client ke paas hai, ya mil nahi rahi. Aaj call karna banta hai.',
  sessionRestCanFollow:
    'Baqi doosre chakkar mein aa sakta hai. Yeh ginti hai, faisla nahi.',
  sessionConfirmedByCase: (n: number): string =>
    `${n} case se confirm ${n === 1 ? 'hui, dekhi nahi gayi' : 'huin, dekhi nahi gayin'}.`,
  sessionABeliefNotAnObservation:
    'Yeh andaza hai, aankhon dekha nahi. Agar is job par damage ka jhagra hua to yeh shamil nahi hongi.',
  sessionNeedsAWord: 'Baat karni hai',
  sessionRecordedEitherWay: 'Har haal mein record hai',
  sessionDidNotComeBack: 'Wapas nahi aaya',
  sessionStillOnTheShelf: 'Abhi tak shelf par hai',
  sessionMoneyNotBack: (money: string): string =>
    `${money} wapas nahi · is job par gaya, scan in nahi hua`,
  sessionMoneyNotInVan: (money: string): string =>
    `${money} day rate ka saaman list par hai, van mein nahi`,
  sessionWentOutNotScannedIn: 'Is job par gaya, scan in nahi hua',
  sessionOnTheListNotInVan: 'List par hai, van mein nahi',
  sessionNoRate: 'rate nahi',
  sessionSendWhatIsStillOut: 'Jo abhi bahar hai, woh bhejein',
  sessionSendTheListOnWhatsApp: 'List WhatsApp par bhejein',
  sessionParchiShowAtTheGate: 'Parchi — gate par dikhayein',
  sessionKeepScanning: 'Scan jari rakhein',
  sessionDoneForNow: 'Abhi ke liye bas',
  sessionNothingHereClosesTheJob:
    'Yahan se na job band hoti hai, na deposit chhootta hai. Woh desk par hota hai, saaman dekhne ke baad.',
  sessionNothingHereConfirms:
    'Yahan se dispatch confirm nahi hota. Desk baad mein karta hai, paison ke saath — truck kabhi nahi rukta.',
  sessionParchiGatePassAria: 'Parchi — gate pass',
  sessionChallanAsQrAlt: 'Challan, QR code ki shakal mein',
  sessionAnyPhoneCameraReadsThis:
    'Koi bhi phone camera isse parh leta hai — challan ka text seedha khul jata hai, kisi app ki zaroorat nahi. Band karne ke liye kahin bhi tap karein.',
  sessionChargeClient: 'Client par charge',
  sessionChargeAria: (name: string): string => `${name} ka charge likhein`,
  sessionChargeAmount: 'Raqam (Rs)',
  sessionChargeNoteOptional: 'Note (zaroori nahi)',
  sessionWriteInKhata: 'Khatay mein likhein',
  sessionChargeGoesTo: (name: string): string =>
    `${name} ke khatay mein jayega`,
  sessionCameBackLate: 'Late wapas aaya',
  sessionLateFeeSub: (dueLabel: string, rate: string): string =>
    `${dueLabel} · day rate ${rate} har din`,
  sessionLateFeeNeverAuto:
    'Sirf draft — raqam aap pakki karein ge. Khud se kuch nahi likha jata.',
  sessionDraftLateFee: 'Late fee ka draft',
  sessionLateFee: 'Late fee',
  sessionUnpricedNotInFee: (n: number): string =>
    `${n} ${cheezein(n)} ka day rate nahi, is raqam mein shamil nahi.`,
  sessionChargeWritten: (name: string): string =>
    `${name} ke khatay mein likh diya`,
  sessionViewKhata: 'Khata kholein',

  // ----------------------------------------------------------------- gear
  gearTitle: 'Saaman',
  gearSubtitle: 'House ka saara saaman',
  gearItemFallback: 'Item',
  gearBackToTheGearAria: 'Wapas saaman par',
  gearFilterEverything: 'Sab kuch',
  gearFilterOnTheShelf: 'Shelf par',
  gearFilterOut: 'Bahar',
  gearFilterNeedsALook: 'Dekhna hai',
  gearFilterGone: 'Nikal gayi',
  gearSearchPlaceholder: 'Naam ya code se dhoondein — FX9, AP600, battery',
  gearClearSearchAria: 'Search saaf karein',
  gearItemCount: (n: number): string => `${n} ${cheezein(n)}`,
  gearKindsSuffix: (kinds: number): string => ` · ${kinds} qism`,
  gearNothingMatches: 'Kuch match nahi hua.',
  gearNoGearCalled: (query: string): string =>
    `“${query}” naam ka koi saaman nahi.`,
  gearNothingInThisFilter: 'Is filter mein abhi kuch nahi.',
  gearSomewhereHere: 'Yahin kahin hai',
  gearOutFallback: 'Bahar',
  gearNoSuchItem: 'Aisi koi cheez nahi.',
  gearBackToTheGear: 'Wapas saaman par',
  gearFactCategory: 'Category',
  gearFactShelf: 'Shelf',
  gearFactSerial: 'Serial',
  gearSerialNotRecorded: 'darj nahi',
  gearFactTag: 'Tag',
  gearNoTag: 'tag nahi',
  gearProveIt: 'Saboot bhejein — is cheez ka record share karein',
  gearCondition: 'Haalat',
  gearNothingPhotographed: 'Koi photo nahi hui',
  gearOutBesideBack: 'Jaate waqt kaisi thi, aur wapsi par kaisi aayi — saath saath',
  gearHistory: 'History',
  gearNothingRecordedYet: 'Abhi kuch record nahi hua',
  gearEntriesNewestFirst: (n: number): string =>
    `${n} record, sab se naya pehle`,
  gearItemHasNotMovedYet: 'Yeh cheez abhi tak kahin nahi gayi.',
  gearScanItOutAndItShowsUp: 'Kisi job par scan out karein, yahan nazar aayegi.',
  gearMethodScanned: 'scan hua',
  gearMethodManual: 'haath se likha gaya',
  gearMethodAssumed: 'assumed — case mein tha, dekha nahi',
  gearMethodImplied: 'apne case ke saath gaya',
  gearMethodCounted: 'gina gaya',
  gearEventWentOut: 'Bahar gaya',
  gearEventCameBack: 'Wapas aaya',
  gearEventIntake: 'Fleet mein add hua',
  gearEventMove: 'Jagah badli',
  gearNoConditionPhotosYet: 'Haalat ki abhi koi photo nahi.',
  gearPhotographOutAndBack:
    'Jaate hue photo lein aur wapsi par phir se — dono yahan saath saath dikhengi.',
  gearGoingOutLabel: 'Jaate hue',
  gearComingBackLabel: 'Wapsi par',
  gearNoPhotoGoingOut: 'Jaate hue photo nahi li',
  gearNotPhotographedBackYet: 'Wapsi ki photo abhi nahi',
  gearWentOutNoMatchingPhoto:
    'Jaate hue photo ke saath gaya, wapsi par koi photo nahi mili.',
  gearPhotographedOnReturnOnly:
    'Sirf wapsi par photo hui — muqable ke liye pehli photo hai hi nahi.',
  gearConditionPhotoAlt: (label: string): string => `${label} haalat ki photo`,
  gearByThisPhonesClock: 'is phone ki clock se',
  gearOnlyOnThisPhone: 'sirf is phone par',
  gearMoneyHeading: 'Paisa',
  gearEarnedAcross: (rupees: string, jobs: number): string =>
    `${jobs} job${jobs === 1 ? '' : 's'} se ${rupees} kamaya`,
  gearNothingEarnedYet:
    'Abhi kuch nahi kamaya — is unit ke naam ka charge yahan aayega.',
  // "Laagat" (cost), not "qeemat": the bar's denominator now carries the
  // unit's repairs too (0019).
  gearPaybackLabel: (pct: number): string =>
    `${pct}% laagat wasool ho gayi`,
  gearPaidForItself: 'Is ne apni qeemat poori kar li.',
  gearNoReplacementValue:
    'Replacement value darj nahi, is liye payback bar nahi.',
  gearTurnedAway: (times: number): string =>
    `Is mahine ${times} dafa mana karna para`,

  // -------------------------------------------------------------- enquiry
  enquiryTitle: 'Kit list',
  enquirySubtitle: 'Client ka message paste karein',
  enquiryPastePlaceholder:
    'Client ka message yahan paste karein…\n\nSalaam dua aur “please confirm” khud hi nazarandaz ho jate hain.',
  enquiryPasteAria: 'Client ka message',
  enquiryCheckAvailability: 'Availability check karein',
  enquiryNewList: 'Nayi list',
  enquiryEverythingIsAvailable: 'Sab kuch available hai',
  enquiryNeedALook: (n: number): string => `${n} ko dekhna parega`,
  enquiryTheyWrote: (raw: string): string => `unhon ne likha: “${raw}”`,
  enquiryOnlyNOfMHere: (onHand: number, wanted: number): string =>
    `${wanted} mein se sirf ${onHand} yahan ${onHand === 1 ? 'hai' : 'hain'}`,
  enquiryNoneOnTheShelf: 'shelf par ek bhi nahi',
  enquiryCopyReply: 'Jawab copy karein',
  enquiryMakeAJobFromThis: 'Is se job banayein',
  enquiryLinesGoOnTheJob: (units: number, lines: number): string =>
    `${lines} line se ${units} ${cheezein(units)} job par jayengi.`,
  enquiryUnconfirmedLeftOut: (base: string, unresolved: number): string =>
    `${base} ${unresolved} unconfirmed line ${unresolved === 1 ? 'reh gayi' : 'reh gayin'} — agar woh bhi chahiye to pehle unko resolve karein.`,

  // --------------------------------------------------------------- hisaab
  hisaabTitle: 'Din ka hisaab',
  hisaabStatWentOut: 'bahar gaya',
  hisaabStatCameBack: 'wapas aaya',
  hisaabStatOnTrust: 'bharose par',
  hisaabStatPhotos: 'photos',
  hisaabCopied: 'Copy ho gaya — WhatsApp mein paste karein',
  hisaabCopyTheDaysAccount: 'Din ka hisaab copy karein',
  hisaabUnknownLabelsScanned: (n: number): string =>
    `Aaj ${n} anjaan label scan ${n === 1 ? 'hua' : 'hue'}.`,
  hisaabLabelsNeverSeen:
    'Aise labels jo is phone ne pehle kabhi nahi dekhe. Record hain, pehchan ka intezar hai.',
  hisaabNothingToday: 'Aaj abhi tak na kuch scan hua, na photo.',
  hisaabTheAccountFillsItself:
    'Jaise jaise saaman scan hota hai, hisaab khud bharta jata hai. Pichhle dinon ka jo abhi bahar hai, woh neeche hai.',
  hisaabWentOutHeading: 'Bahar gaya',
  hisaabCameBackHeading: 'Wapas aaya',
  hisaabNOut: (n: number): string => `${n} bahar`,
  hisaabNBack: (n: number): string => `${n} wapas`,
  hisaabNPhotos: (n: number): string => `${n} photo${n === 1 ? '' : 's'}`,
  hisaabPhotographedOnly: 'Sirf photo hui',
  hisaabStillOut: 'Abhi bahar',
  hisaabEverythingIsHome: 'Sab kuch ghar par hai',
  hisaabWithTheClient: 'Client ke paas — kab se, yeh due wala label batata hai',
  hisaabOnTrustCount: (n: number): string => ` · ${n} bharose par`,
  hisaabTakenOnTrust: 'Bharose par liya — dekha nahi',

  // --------------------------------------------------------------- labels
  labelsTitle: 'Labels',
  labelsImportDoor: 'List se apna samaan load karo',
  labelsSubtitle: (tags: number): string =>
    `${tags} tags · print karein, ya doosri screen par kholein`,
  labelsPrintTheseHint:
    'Inhein sticker paper par print kar ke har cheez par ek lagayein. Phir label scan karein aur tap karein',
  labelsAttachThisLabel: 'Yeh label lagayein',
  labelsToSayWhatItIsOn: 'taake pata chale kis cheez par hai.',
  labelsDrawingLabels: 'Labels ban rahe hain…',
  labelsPrintTheLabels: 'Labels print karein',
  labelsLoadYourGear: 'Apna saaman load karein',
  labelsImportSubtitle: 'List paste karein, check karein, phir add karein',
  labelsImportLead:
    'Apne saaman ki list paste karein — seedha Excel, Google Sheets, ya CSV se. Jab tak aap dekh na lein kya hoga, kuch save nahi hota.',
  labelsImportPlaceholder: 'Item Description,Qty,Asset Code,Shelf\nSony FX9,2,FX9,Rack A\n…',
  labelsImportAria: 'Aapke saaman ki list',
  labelsTryASampleList: 'Sample list se try karein',
  labelsStartAgain: 'Dobara shuru karein',
  labelsCheckTheColumns: 'Columns check karein',
  labelsRowsTheseAreGuesses: (rows: number): string =>
    `${rows} ${rows === 1 ? 'row' : 'rows'} · yeh andaze hain`,
  labelsRequired: 'zaroori',
  labelsNotInThisFile: '— is file mein nahi —',
  labelsColumnN: (n: number): string => `Column ${n}`,
  labelsWhichColumnIsTheName: 'Product ka naam kaunse column mein hai?',
  labelsNothingCanBeRead: 'Jab tak woh set na ho, kuch parha nahi ja sakta.',
  labelsFieldProductName: 'Product ka naam',
  labelsFieldAssetCode: 'Asset code',
  labelsFieldSerialNumber: 'Serial number',
  labelsFieldCategory: 'Category',
  labelsFieldHowMany: 'Kitne hain',
  labelsFieldShelf: 'Shelf',
  labelsWhatThisWouldDo: 'Is se kya hoga',
  labelsNothingIsSavedYet: 'Abhi kuch save nahi hua',
  labelsStatNewProducts: 'naye products',
  labelsStatAlreadyKnown: 'pehle se maloom',
  labelsStatNeedALook: 'dekhna hai',
  labelsStatUnusable: 'bekaar',
  labelsLineN: (n: number): string => `Line ${n}`,
  labelsCloseTo: (candidates: string): string =>
    `${candidates} se milta julta — apna alag product rakha gaya`,
  labelsLineNCode: (n: number): string => `line ${n}`,
  labelsAddNItems: (n: number): string =>
    `${n} ${cheezein(n)} add karein`,
  labelsRowsMarkedNeedALook:
    '“Dekhna hai” wali rows apna alag product ban ke aati hain, kisi milti julti mein merge nahi hoteen. Jo pehle se maujood hai, us par kuch nahi likha jata.',
  labelsAddedAcross: (units: number, products: number): string =>
    `${units} ${cheezein(units)} add ho ${units === 1 ? 'gayi' : 'gayin'}, ` +
    `${products} ${products === 1 ? 'naya product' : 'naye products'} mein.`,
  labelsCodesContinued: (n: number): string =>
    `${n} asset code pehle se istemaal mein ${n === 1 ? 'tha' : 'thay'} — ` +
    'duplicate banane ki bajaye numbering aage barhai gayi.',
  labelsYourNamesAreNowMatched:
    'Ab kit-list reader client ke message ko inhi naamon se milata hai.',
  labelsSeeTheGear: 'Saaman dekhein',
  labelsLoadAnotherList: 'Aur list load karein',
  labelsBackedUpHeading: 'Backup',
  labelsQueueStatus: (n: number): string =>
    n === 0
      ? 'Queue khali · demo mode — is device se kuch nahi jata'
      : `${n} scan queue mein · demo mode — is device se kuch nahi jata`,
  labelsPaymentHeading: 'Paise lene ka tareeqa',
  labelsPaymentSub: 'Har statement pe likhi line aur QR',
  labelsPaymentLineLabel: 'Statement ke liye payment line',
  labelsPaymentLinePlaceholder: 'maslan JazzCash: 0300 1234567',
  labelsPaymentLineHint:
    'Set hone par har balance card aur statement ke neechay likhi jati hai.',
  labelsPaymentQrLabel: 'Payment QR',
  labelsAttachQr: 'QR image lagayein',
  labelsRemoveQr: 'QR hatayein',
  labelsQrStored: 'Sirf isi device par rehta hai.',
  labelsSave: 'Save karein',
  labelsSaved: 'Save ho gaya',

  // ------------------------------------------------------------- customer
  customerKhata: 'Khata',
  customerNoSuchCustomer: 'Aisa koi customer nahi.',
  customerBalanceHeading: 'Balance',
  customerDepositHeldLine: (rupees: string): string =>
    `Zamanat rakhi hui: ${rupees}`,
  customerRecordPayment: 'Wusooli likhein',
  customerSendBalance: 'Balance bhejein',
  customerMonthlyStatement: 'Mahine ka hisaab',
  customerCopied: 'Copy ho gaya — WhatsApp mein paste karein',
  customerBookHeading: 'Poora hisaab',
  customerEntriesNewestFirst: (n: number): string =>
    `${n} ${n === 1 ? 'entry' : 'entries'}, nayi pehle`,
  customerNothingInBook: 'Khatay mein abhi kuch nahi.',
  customerLinkedJobs: 'Jobs',
  customerJobClosed: 'band',
  customerPaymentAmount: 'Raqam (Rs)',
  customerPaymentNoteOptional: 'Note (zaroori nahi)',
  customerSavePayment: 'Wusooli darj karein',
  customerMethodCash: 'Cash',
  customerMethodJazzCash: 'JazzCash',
  customerMethodEasypaisa: 'Easypaisa',
  customerMethodBank: 'Bank',
  customerOwedTitle: 'Mera udhaar',
  customerOwedSubtitle: (n: number): string =>
    `${n} customer${n === 1 ? '' : 's'} par udhaar`,
  customerNobodyOwes: 'Abhi kisi par kuch nahi.',
  customerOwedDoorToday: 'Aaj ki jobs',
  customerOwedTapOne: 'Naam par tap karein, khata khulega',
  customerCardTitle: (name: string): string => `Hisaab — ${name}`,
  customerStatementTitle: (name: string, month: string): string =>
    `Statement — ${name} · ${month}`,
  customerCardBalanceLine: (rupees: string): string => `Balance: ${rupees}`,
  customerStatementClosingLine: (rupees: string): string =>
    `Aakhri balance: ${rupees}`,
  customerNothingOwed: 'Kuch baqaya nahi',
  customerHouseOwes: (rupees: string): string => `Aap ke zimme ${rupees}`,
  customerOwedSince: (date: string): string => `${date} se baqaya`,
  customerKindLabel: (kind: string): string => KIND_UR[kind] ?? kind,
  customerNothingThisMonth: 'Is mahine kuch darj nahi hua.',
  customerChargedButReturned: (rupees: string, code: string, job: string): string =>
    `${job} par ${code} ka ${rupees} charge hua — cheez wapas aa gayi. Mansookh karein?`,
  customerReverseDraft: 'Mansookh…',
  customerReverseConfirm: (rupees: string): string =>
    `Pakka karein — ${rupees} wapas likhein`,
  customerReversedNote: 'Charge hua, phir cheez wapas aa gayi — mansookh',

  // --------------------------------------------------------------- kharcha
  kharchaHeading: 'Kharcha',
  kharchaAddExpense: 'Kharcha likhein',
  kharchaRepairCost: 'Marammat ka kharcha',
  kharchaKindLabel: (kind: string): string => KHARCHA_UR[kind] ?? kind,
  kharchaAmount: 'Raqam (Rs)',
  kharchaPaidToOptional: 'Kis ko diya (zaroori nahi)',
  kharchaPaidToPlaceholder: 'maslan Sharif Camera Works',
  kharchaNoteOptional: 'Note (zaroori nahi)',
  kharchaDatePaid: 'Tareekh',
  kharchaDatePaidHint:
    'Pehle kisi din diya tha? Tareekh set karein, hisaab usi din likhega.',
  kharchaSaveExpense: 'Kharcha darj karein',
  kharchaForAsset: (code: string): string =>
    `${code} ke liye — is ki cost history mein jayega`,
  kharchaAssetCost: (rupees: string, repairs: number): string =>
    `Laagat ${rupees} (khareed + ${repairs} marammat)`,
  kharchaAssetRepairsOnly: (rupees: string, repairs: number): string =>
    `Marammat ${rupees} (${repairs} dafa) — khareed ki qeemat darj nahi`,
  kharchaJobMarginLine: (earned: string, costs: string): string =>
    `${earned} kamaya · ${costs} kharcha`,
  kharchaDaySpent: (rupees: string): string => `Aaj ${rupees} kharch hue`,
  kharchaDayNone: 'Aaj koi kharcha darj nahi hua.',
  kharchaMonthHeading: 'Mahine ka hisaab',
  kharchaMonthEarned: 'Kamai',
  kharchaMonthSpent: 'Kharcha',
  kharchaMonthProfitLabel: 'Munafa — kamai minus kharcha',
  kharchaNoExpensesThisMonth: 'Is mahine koi kharcha darj nahi hua.',
  kharchaReversedNote: 'Ghalat likha gaya — mansookh',

  // --------------------------------------------------------------- closed
  closedJobsTitle: 'Band jobs',
  closedJobsSubtitle: (n: number): string =>
    n === 1 ? '1 job mukammal' : `${n} jobs mukammal`,
  closedJobsEmpty: 'Abhi koi band job nahi.',
  closedJobsEmptyHint: 'Sab kuch wapas aa jaye to job ke card se band karein.',
  closedJobsDoorToday: 'Aaj ki jobs',
  closedJobsDoor: 'Band jobs',
  closedJobsReopen: 'Dobara kholein',
  closedJobsClosedOn: (date: string): string => `${date} ko band hui`,
  closedJobsNeverCameBack: (n: number): string =>
    n === 1 ? '1 cheez kabhi wapas nahi aayi' : `${n} cheezein kabhi wapas nahi aayin`,

  // ----------------------------------------------------------------- fleet
  fleetGoneHeading: 'Yeh cheez fleet se nikal gayi',
  fleetDispositionWord: (d: string): string =>
    ({ lost: 'gum', stolen: 'chori', sold: 'bik gayi', retired: 'retire', returned_to_owner: 'maalik ko wapas' }[d] ?? d),
  fleetMarkGone: 'Gum, chori ya bech di — mark karein',
  fleetMarkGoneHint:
    'Yeh cheez ko fleet se nikaal dete hain. Kholne ke liye daba ke rakhein, phir confirm.',
  fleetHoldToReveal: 'Kholne ke liye daba ke rakhein',
  fleetLost: 'Gum',
  fleetStolen: 'Chori',
  fleetSold: 'Bech di',
  fleetMarkNoteLabel: 'Kya hua? (optional)',
  fleetSaleAmountLabel: 'Bikri ki raqam (Rs, optional)',
  fleetSaleAmountHint:
    'Cheez par note ke taur par mehfooz — abhi paison ki kitaab par nahi.',
  fleetConfirmLost: 'Confirm — gum mark karein',
  fleetConfirmStolen: 'Confirm — chori mark karein',
  fleetConfirmSold: 'Confirm — bikri mark karein',
  fleetMarkedNote: (word: string): string => `${word} mark ki`,
  fleetFound: 'Mil gayi — wapas fleet mein',
  fleetFoundNote: 'Mil gayi — wapas fleet mein',
  fleetStampLost: 'gum',
  fleetStampStolen: 'chori',
  fleetStampSold: 'bik gayi',
  fleetStampRetired: 'retire',
  // --- network --- (0025 D5): a borrowed unit that went home.
  fleetStampReturnedToOwner: 'maalik ko wapas',
  fleetTheftReport: 'Chori ki report',
  fleetTheftHeading: 'CHORI KI REPORT',
  fleetTheftBanner: 'Yeh saman CHORI report hua hai.',
  fleetTheftCodeLabel: 'Code',
  fleetTheftSerialLabel: 'Serial',
  fleetTheftNoSerial: 'darj nahi',
  fleetTheftPhotos: (n: number): string =>
    n === 0
      ? 'Koi condition photo record par nahi.'
      : n === 1
        ? '1 condition photo record par.'
        : `${n} condition photos record par.`,
  fleetTheftLastSeen: 'Aakhri baar dekha',
  fleetTheftLastSeenLine: (when: string, jobLabel: string | null): string =>
    jobLabel ? `${when} — ${jobLabel} par` : when,
  fleetTheftLastSeenUnknown: 'Koi scan record par nahi.',
  fleetTheftContact: 'Raabta',
  fleetTheftFooter: (houseName: string): string =>
    `${houseName} ki taraf se report. Koi maloomat ho to raabta karein.`,
  fleetSwapOntoJob: 'Job par swap karein',
  fleetSwapTitle: 'Substitute swap karein',
  fleetSwapBrokenLine: (code: string, jobLabel: string): string =>
    `${code} ${jobLabel} se hatega aur flag ho jayega.`,
  fleetSwapPickSubstitute: 'Substitute chunein',
  fleetSwapSamePreferred: 'Wahi product, shelf par',
  fleetSwapOther: 'Shelf par koi aur cheez',
  fleetSwapNoSubstitutes: 'Shelf par bhejne layak kuch nahi.',
  fleetSwapConfirm: 'Swap — dono harkatein record karein',
  fleetSwapDone: (broken: string, sub: string): string =>
    `${sub} bahar; ${broken} wapas aur flag.`,
  fleetSwapNoLiveJob: 'Yeh cheez kisi live job par bahar nahi ke swap ho.',
  fleetGinti: 'Ginti',
  fleetGintiSubtitle: 'Kitaab ke against shelf ginein',
  fleetGintiScanShelf: 'Shuru karne ke liye shelf tag scan karein ya shelf chunein',
  fleetGintiPickShelf: 'Shelf chunein',
  fleetGintiNoShelves: 'Abhi koi shelf nahi — saaman ki list ke saath aati hain.',
  fleetGintiCounting: (shelf: string): string => `${shelf} gin rahe hain`,
  fleetGintiSeen: (n: number): string => `${n} dekhi`,
  fleetGintiOk: (n: number): string => `${n} mil gayi`,
  fleetGintiMissing: (n: number): string => `${n} gayab`,
  fleetGintiUnexpected: (n: number): string => `${n} is shelf par nahi`,
  fleetGintiScanItems: 'Shelf ki cheezein scan karein',
  fleetGintiFinish: 'Ginti mukammal karein',
  fleetGintiReportButton: 'Farq ki report copy karein',
  fleetGintiClean: 'Is shelf ki har cheez mil gayi.',
  fleetGintiReportHeading: 'GINTI',
  fleetGintiReportShelf: (shelf: string): string => `Shelf: ${shelf}`,
  fleetGintiReportMissing: 'GAYAB (honi chahiye thi, nahi mili):',
  fleetGintiReportUnexpected: 'IS SHELF PAR NAHI (phir bhi yahan mili):',
  fleetGintiReportOkLine: (n: number): string => `${n} kitaab se mil gayin.`,
  fleetGintiReportDecide:
    'Gayab cheezein aap ke faisle par — kahin aur mili, ya gum.',

  // ----------------------------------------------------------------- sehat
  // 'Sehat' aur 'service due' waise hi rehte hain — trade yehi bolta hai.
  sehatHeading: 'Sehat',
  sehatSubtitle: 'Fleet mein kahan dekhna zaroori hai',
  sehatServiceDue: 'Service due',
  sehatServiceRow: (days: number, dueAfter: number): string =>
    `${days} kiraya din · ${dueAfter} par due`,
  sehatCyclesOver: 'Cycle hadd se aage',
  sehatCycleRow: (cycles: number, ceiling: number): string =>
    `${cycles} cycles · hadd ${ceiling}`,
  sehatDeadStock: (days: number): string => `${days}+ din se pari hui`,
  sehatDeadRow: (idleDays: number): string => `${idleDays} din se pari hui`,
  sehatSinceLine: (days: number, dueAfter: number | null): string =>
    dueAfter === null
      ? `Service ke baad ${days} kiraya din`
      : `Service ke baad ${days} kiraya din · ${dueAfter} par due`,
  sehatNeedsALookStamp: 'Dekhna zaroori — service ka waqt guzar gaya',
  sehatCycleLine: (cycles: number, ceiling: number | null): string =>
    ceiling === null ? `${cycles} cycles darj` : `${ceiling} mein se ${cycles} cycles`,
  sehatCycleOverStamp:
    'Cycle hadd guzar gayi — khud kuch nahi badalta; aap dekhein',
  sehatServicedButton: 'Service ho gayi',
  sehatServicedTitle: 'Service darj karein',
  sehatServicedHint: (code: string): string =>
    `${code} ka service clock zero hoga. Cost dein to kharcha kitaab mein marammat bhi likhi jayegi, isi cheez ke naam.`,
  sehatServicedNoteLabel: 'Kya kaam hua? (optional)',
  sehatServicedCostLabel: 'Cost (Rs, optional)',
  sehatServicedConfirm: 'Confirm — service darj karein',

  // ----------------------------------------------------------------- awaaz
  awaazNote: 'Awaaz note',
  awaazHold: 'Daba ke rakhein, bolein',
  awaazRecording: 'Recording — chhorein to mehfooz',
  awaazSaved: 'Is phone par mehfooz',
  awaazMicRefused: 'Mic ki ijazat nahi mili — kuch record nahi hua.',
  awaazDeviceFull: (waiting: number): string =>
    `Phone bhar gaya — ${waiting} note${waiting === 1 ? '' : 's'} abhi bhejne baaqi. ` +
    'Kuch delete nahi hua.',
  awaazCount: (n: number): string => `${n} awaaz note${n === 1 ? '' : 's'}`,
  awaazNothingYet: 'Abhi koi awaaz note nahi — button daba ke bol dein.',
  awaazRecordedAt: (when: string): string =>
    `${when} par record hui — isi phone ki ghari se`,
  awaazHoldAria: (target: string): string => `${target} ke liye awaaz note record karein`,

  // --------------------------------------------------------------- booking
  bookingStatusDraft: 'Draft',
  bookingStatusConfirmed: 'Pakki',
  bookingStatusCancelled: 'Cancel',
  bookingStatusExpired: 'Pencil khatam',
  bookingSeasonWedding: 'Shaadi season',
  bookingPencilLeft: (hours: number, minutes: number): string =>
    `Pencil — ${hours}h ${minutes}m baaqi`,
  bookingActionNudge: 'WhatsApp yaad dilao',
  bookingActionCall: 'Client ko call karo',
  bookingActionLateFee: 'Late fee ka draft banao',
  bookingActionManager: 'Manager tak le jao',
  bookingCollision: (code: string, no: number, name: string): string =>
    `${code} pehle se booking #${no} (${name}) ko wada hai`,
  bookingShort: (available: number, wanted: number, product: string): string =>
    `In dates pe ${product} ke sirf ${available} of ${wanted} khali hain`,
  bookingNeedsCredentials: (rupees: string): string =>
    `${rupees} ke wade se pehle kaghaz chahiye — manager note likh ke override kar sakta hai`,
  bookingBlacklisted: 'Yeh customer blacklist hai — booking pakki nahi ho sakti',
  bookingAlreadyConfirmed: (no: number): string => `Booking #${no} pehle se pakki hai`,
  bookingIsCancelled: (no: number): string => `Booking #${no} cancel hai`,
  bookingJobOpen: (no: number, label: string): string =>
    `Booking #${no} job “${label}” pe bahar hai — pehle job band karo`,
  bookingConfirmTitle: (house: string): string => `${house} — booking pakki`,
  bookingConfirmNo: (no: number): string => `Booking #${no}`,
  bookingConfirmFor: (name: string): string => `Naam: ${name}`,
  bookingConfirmWindow: (from: string, until: string): string =>
    `${from} se ${until} tak`,
  bookingConfirmItems: 'Samaan:',
  bookingConfirmLine: (qty: number, name: string): string => `${qty}x ${name}`,
  bookingConfirmNote: (note: string): string => `Note: ${note}`,
  bookingConfirmFooter: 'Kuch badalna ho to yahin reply karein. Shukriya.',

  bookingDeskTitle: 'Desk',
  bookingDeskSubtitle: 'Kit list, calendar, bookings',
  bookingKitListHeading: 'Kit list',
  bookingKitListSub: 'Client ne jo bheja, paste karo',
  bookingCalendarHeading: 'Calendar',
  bookingOpenCalendar: 'Calendar kholo',
  bookingListHeading: 'Bookings',
  bookingListSub: (n: number): string => `${n} live booking${n === 1 ? '' : 's'}`,
  bookingNoneYet: 'Abhi koi booking nahi — kit list ya calendar se pencil karo.',
  bookingNew: 'Nayi booking',
  bookingItems: (n: number): string => `${n} ${cheezein(n)}`,
  bookingRowNo: (no: number): string => `#${no}`,

  bookingCalendarTitle: 'Calendar',
  bookingCalendarSubtitle: 'Pakki bookings, live pencils',
  bookingPrevMonthAria: 'Pichla mahina',
  bookingNextMonthAria: 'Agla mahina',
  bookingLegendConfirmed: 'pakki',
  bookingLegendPencilled: 'pencil',
  bookingDayHeading: (day: string): string => `${day} ko`,
  bookingNothingThatDay: 'Us din kuch wada nahi.',
  bookingNoneThisMonth: 'Is mahine abhi koi wada nahi.',
  bookingTapADay: 'Din pe tap karo — dekho us din kya wada hai.',
  bookingMonthCounts: (confirmed: number, pencilled: number): string =>
    `${confirmed} pakki · ${pencilled} pencil`,

  bookingTitle: (no: number): string => `Booking #${no}`,
  bookingNoSuchBooking: 'Yeh booking is phone pe nahi.',
  bookingBackToCalendar: 'Calendar pe wapas',
  bookingFromLabel: 'Se',
  bookingUntilLabel: 'Tak',
  bookingHeldUntil: (until: string): string => `Fleet ${until} tak rukha hua hai`,
  bookingLinesHeading: 'Kya wada hai',
  bookingLineQty: (qty: number, name: string): string => `${qty} × ${name}`,
  bookingLineAllocated: (codes: string): string => `Units: ${codes}`,
  bookingLineDemanded: (code: string): string => `Yehi unit: ${code}`,
  bookingLineUnallocated: 'Units pakki hone pe lagenge',
  bookingNoteHeading: 'Note',
  bookingCancelReason: (reason: string): string => `Wajah: ${reason}`,
  bookingExpiredHint: 'Yeh pencil khatam ho gayi — client abhi bhi pooch raha hai to dobara pencil karo.',
  bookingOnJob: (label: string): string => `Job “${label}” pe bahar hai`,
  bookingOpenJob: 'Job kholo',
  bookingWaitingToSend: 'Bhejna baaqi hai — pipe khulne pe server yeh wada dobara check karega.',
  bookingDoorConfirm: 'Pakki karo',
  bookingDoorExtend: 'Barhao',
  bookingDoorConvert: 'Job banao',
  bookingDoorSend: 'WhatsApp pe confirmation bhejo',
  bookingDoorCancel: 'Booking cancel karo',
  bookingCancelHint: 'Har unit chhoot jayegi. Daba ke rakho — wapas nahi hoti.',
  bookingCancelReasonLabel: 'Kyun? (optional)',
  bookingCancelReasonPlaceholder: 'jaise: client ne date aage kar di',
  bookingConvertNotConfirmed: 'Sirf pakki booking job banti hai',
  bookingConvertAlreadyJob: 'Yeh booking pehle se job hai',

  bookingConfirmSheetTitle: (no: number): string => `Booking #${no} pakki karo`,
  bookingConfirmSheetHint: 'Pakki karne se units is client ke naam lag jati hain. Pipe khulne pe server dobara check karega.',
  bookingLayerLine: (hereNow: number, pencilled: number, confirmed: number): string =>
    `${hereNow} abhi yahan · ${pencilled} pencil · ${confirmed} in dates pe pakki`,
  bookingWillTake: (codes: string): string => `${codes} lagenge`,
  bookingWillHold: (qty: number): string => `Stock se ${qty} rukhenge`,
  bookingSameDayTurnaround: 'Same-day turnaround — koi prep ya turnaround buffer nahi',
  bookingSameDayHint: 'Fleet bilkul client ki dates tak rukhega. Jab agli job usi shaam nikalti ho.',
  bookingHoldWindow: (from: string, until: string): string => `${from} se ${until} tak rukha`,
  bookingOverrideNoteLabel: 'Manager ka override note',
  bookingOverrideNotePlaceholder: 'jaise: Bilal ka jaanne wala, cheque rakha hai',
  bookingConfirmNow: 'Pakki karo — units lagao',
  bookingConfirmed: (no: number): string => `Booking #${no} pakki`,
  bookingConfirmedWith: (codes: string): string => `Units lagi: ${codes}`,
  bookingBlockedPeriodUncovers: 'Hold client ki poori window cover kare',
  bookingNotFound: 'Booking is phone pe mili nahi',

  bookingNewTitle: 'Nayi booking',
  bookingNewFromKitList: (n: number): string => `Kit list se ${n} line${n === 1 ? '' : 's'}`,
  bookingNewCustomerLabel: 'Kis ki booking?',
  bookingNewCustomerNeeded: 'Booking ke liye customer chahiye — wada kisi se hota hai.',
  bookingNewCustomerNameLabel: 'Customer ka naam',
  bookingNewCustomerPhoneOptional: 'Phone (optional)',
  bookingNewStartLabel: 'Pickup',
  bookingNewEndLabel: 'Wapsi',
  bookingNewLinesLabel: 'Kya chahiye',
  bookingNewAddLine: 'Samaan add karo',
  bookingNewSearchGear: 'Catalogue mein dhoondo',
  bookingNewNothingMatches: (q: string): string => `“${q}” se kuch nahi mila`,
  bookingNewNoLines: 'Kam az kam aik cheez add karo.',
  bookingNewRemoveLineAria: (name: string): string => `${name} hatao`,
  bookingNewMoreAria: (name: string): string => `${name} aik aur`,
  bookingNewFewerAria: (name: string): string => `${name} aik kam`,
  bookingNewKindLabel: 'Pencil ya pakki?',
  bookingNewPencil: 'Pencil',
  bookingNewPencilHint: (hours: number): string =>
    `Pencil sirf baat hai — kuch nahi rukhti aur ${hours}h baad khatam.`,
  bookingNewConfirm: 'Abhi pakki',
  bookingNewConfirmHint: 'Pakki karne se units aaj hi is client ke naam lag jati hain.',
  bookingNewNoteLabel: 'Note (optional)',
  bookingNewNotePlaceholder: 'jaise: mehndi + baraat, DHA',
  bookingNewCreate: 'Pencil karo',
  bookingNewCreateConfirmed: 'Book karo aur pakki',
  bookingNewBadPeriod: 'Wapsi pickup ke baad honi chahiye.',
  bookingNewPencilStands: (no: number): string =>
    `Pencil #${no} rakhi hai — takraao theek karo, phir uske page se pakki karo.`,
  bookingNewConsumable: (name: string): string => `${name} consumable hai — bikta hai, book nahi hota`,
  bookingNewUnknownProduct: 'Yeh product catalogue mein nahi',
  bookingNewNoCustomer: 'Yeh customer is phone pe nahi',

  bookingExtendTitle: (no: number): string => `Booking #${no} barhao`,
  bookingExtendHint: 'Nayi wapsi chuno. Kuch badalne se pehle preview batata hai kaun is samaan ka intezaar kar raha hai.',
  bookingExtendNewEndLabel: 'Nayi wapsi',
  bookingExtendClean: 'Is samaan ka koi intezaar nahi kar raha',
  bookingExtendNow: 'Barhao',
  bookingExtendBlocked: (n: number): string =>
    `${n} client is samaan ke intezaar mein — pehle har card nipta lo`,
  bookingExtendEndsBeforeStart: 'Nayi wapsi pickup ke baad honi chahiye.',
  bookingExtended: (no: number, until: string): string => `Booking #${no} ab ${until} tak chalegi`,
  bookingCollisionCard: (no: number, name: string, starts: string): string =>
    `#${no} ko wada · ${name} · ${starts} se`,
  bookingCollisionBulk: (shortBy: number, name: string): string => `${shortBy} × ${name} kam`,
  bookingDoorSubRent: 'Sub-rent',
  bookingDoorSubstitute: 'Badlo',
  bookingDoorCall: 'Call',
  bookingCopyName: 'Naam copy karo',
  bookingSubRentNote: (product: string, qty: number, no: number): string =>
    `#${no} ke liye ${product} ×${qty} sub-rent`,
  bookingSubRentNoted: 'Sub-rent booking pe likh liya',
  bookingSubRentHint: 'Partner ka unit shelf pe aane tak unka dawa is unit pe rahega; yeh extension uske peeche queue hogi.',
  bookingSubstituteTitle: (code: string, no: number): string => `#${no} ko ${code} ki jagah doosra unit do`,
  bookingSubstituteHint: (name: string): string =>
    `Sirf doosra ${name}. Unit pe tap karo — unka dawa us pe chala jayega, booking pakki rahegi.`,
  bookingSubstituteNone: 'Unki dates pe is product ka koi unit khali nahi — sub-rent karo, ya call karo.',
  bookingCardSettled: 'Nipat gaya',
  bookingCopied: 'Copy ho gaya',

  todayPromisedHeading: 'Wade',
  todayPromisedSub: 'Agle do din mein shuru, aur aaj khatam hoti pencils',
  todayStartsAt: (when: string): string => `${when} se shuru`,
  todayEscalationStep: (days: number, action: string): string =>
    `Din ${days} — ${ESCALATION_UR[action] ?? action}`,
  todayEscalated: (when: string): string => `${when} se manager ke paas`,
  todayEscalateConsiderBlacklist: 'Din 14 — manager dekhe to blacklist ka bhi socho',
  bookingManagerEscalationText: (job: string, days: number, items: string, customer: string | null): string =>
    [
      `LATE — manager dekhe`,
      `Job: ${job}${customer ? ` (${customer})` : ''}`,
      `${days} din late · ${items}`,
      `Yaad dilaya, call kiya, late fee ka draft bana. Ab aap dekh lein.`,
    ].join('\n'),

  bookingPromisedStamp: (no: number, day: string): string => `Wada · #${no} ${day}`,
  bookingPromisedRightNow: (no: number, name: string, when: string): string =>
    `Booking #${no} (${name}) ko wada hai — hold ${when} se shuru`,

  // ----------------------------------------------------------------- quote
  quoteSheetTitle: 'Quote',
  quoteSheetTitleFor: (no: number): string => `Quote — booking #${no}`,
  quoteStampIndicative: 'Andaazan',
  quoteStampVerified: 'Verified — halka deposit',
  quoteStampUnpriced: 'Rate nahi — rate batao',
  quoteLineDays: (qty: number, days: number, rate: string): string =>
    `${qty} × ${days} din × ${rate}`,
  quoteLineOverridden: (reason: string): string => `Override: ${reason}`,
  quoteRateFieldLabel: (name: string): string => `${name} ka din ka rate, rupay`,
  quoteRateFieldPlaceholder: 'maslan 8000',
  quoteRateSave: 'Rate set karo',
  quoteTotalLabel: 'Total',
  quoteTotalUnpriced: (n: number): string => `+${n} bina rate`,
  quoteSubHireLine: (cost: string, margin: string): string => `sub-hire ${cost} → margin ${margin}`,
  quoteHowHeading: 'Yeh hisaab kaise bana',
  quoteStepDays: (calendarDays: number, first: string): string =>
    `${first} se ${calendarDays} din — pickup se 24 ghante, aik minute late wapsi agla din hai`,
  quoteStepWeekendDropped: (n: number, dates: string): string =>
    `${n} weekend din bill nahi hue: ${dates}`,
  quoteStepMinApplied: (min: number): string => `${min} din ke minimum se kam — ${min} bill hua`,
  quoteStepWeekRule: (billable: number, counted: number, weeks: number, weekDays: number, remainder: number): string =>
    `${billable} bill wale din: ${counted} din = ${weeks} hafta (${weeks * weekDays}) + ${remainder}`,
  quoteStepWeekRuleShort: (billable: number): string => `${billable} bill wale din`,
  quoteStepCardRates: (priced: number, unpriced: number, card: string): string =>
    `${priced} line “${card}” card se priced, ${unpriced} bina rate`,
  quoteStepNoCard: 'Abhi koi rate card nahi — Settings → Rates mein banao, tab tak har line bina rate hai',
  quoteStepMultiplier: (name: string, day: string, multiplier: string): string =>
    `${day} ko ${name}: poori booking pe ${multiplier}`,
  quoteStepMultiplierNone: 'In dates mein koi chhutti ya season nahi',
  quoteStepOverrides: (n: number): string => `${n} line malik ke rate pe — un pe multiplier nahi lagta`,
  quoteIndicativeUnpriced: (n: number): string => `${n} ${cheezein(n)} bina rate — total poori kahani nahi`,
  quoteIndicativeNotConfirmed: 'Abhi pakki nahi — quote hai, bill nahi',
  quoteDoorSend: 'WhatsApp pe bhejo',
  quoteDoorBook: 'Book karo',
  quoteDoorPrice: 'Price lagao',
  quoteDoorSendQuote: 'Quote bhejo',
  quoteOverrideDoor: 'Rate override karo',
  quoteOverrideHint: 'Override ke liye dabaye rakho — malik ka number is line pe card rate ki jagah lagega, wajah saath rahegi.',
  quoteOverrideTitle: (name: string): string => `${name} ke liye malik ka rate`,
  quoteOverrideRateLabel: 'Din ka rate, rupay',
  quoteOverrideReasonLabel: 'Kyun?',
  quoteOverrideReasonPlaceholder: 'maslan purana client, phone pe tay hua',
  quoteOverrideSave: 'Yeh rate lagao',
  quoteOverrideClear: 'Wapas card rate pe',
  quoteOverrideNeedsReason: 'Override ki wajah likhna zaroori hai.',
  quoteCopied: 'Copy ho gaya — WhatsApp mein paste karo',
  quoteNoLines: 'Price lagane ko kuch nahi — pehle kam az kam aik line resolve karo.',
  quoteDepositHint: (hint: string): string =>
    hint === 'refuse' ? 'booking nahi — blacklist'
    : hint === 'lighter' ? 'aadha deposit'
    : hint === 'standard' ? 'aam deposit'
    : 'poora deposit — pehli booking',
  quoteDepositLabel: 'Deposit',

  quoteWindowLabel: 'In dates ke liye',
  quoteWindowStart: 'Pickup',
  quoteWindowEnd: 'Wapsi',
  quoteWindowBad: 'Wapsi pickup ke baad honi chahiye.',
  quoteReplyLine: (total: string, days: number): string =>
    `Quote: ${days} bill wale din ke ${total}`,
  quoteReplyIndicative: (n: number): string =>
    `(andaazan — ${n} ${cheezein(n)} bina rate, final quote desk se)`,

  quoteSectionHeading: 'Quote',
  quoteSectionSub: (days: number): string => `${days} bill wale din`,
  quoteConfirmUnpriced: (n: number): string =>
    `${n} line bina rate — pakki kar sakte ho, rate lagne tak quote andaazan rahega`,

  quoteRatesDoor: 'Rates aur calendar',
  quoteRatesDoorSub: 'Rate card, har cheez ka din ka rate, chhuttiyan aur season',
  quoteRatesTitle: 'Rates',
  quoteRatesSubtitle: 'Card, din ke rates, calendar',
  quoteCardHeading: 'Rate card',
  quoteCardSub: (name: string): string => `“${name}” — default card`,
  quoteCardNone: 'Abhi koi rate card nahi. Neeche settings bhar ke banao.',
  quoteCardWeekLabel: 'Aik hafta kitne din ka bill hai',
  quoteCardMinDaysLabel: 'Kam az kam bill wale din',
  quoteCardWeekendLabel: 'Jo din bill nahi hote',
  quoteCardWeekendHint: 'Har din bill hota hai jab tak yahan koi din tick na ho. Sirf weekend wali job bhi minimum bill hoti hai.',
  quoteCardSave: 'Card save karo',
  quoteCardSaved: 'Card save ho gaya — bhejne ka intezaar',
  quoteRatesListHeading: 'Din ke rates',
  quoteRatesNoCard: 'Upar wala card save hone tak din ke rates nahi.',
  quoteRatesListSub: (priced: number, total: number): string => `${total} mein se ${priced} priced`,
  quoteRatesSearch: 'Cheez dhoondo',
  quoteRateUnpriced: 'bina rate',
  quoteRateSetAria: (name: string): string => `${name} ka rate set karo`,
  quoteRatePerDay: (rate: string): string => `${rate}/din`,
  quoteCalendarHeading: 'Chhuttiyan aur season',
  quoteCalendarSub: (holidays: number, seasonDays: number): string =>
    `${holidays} chhutti · ${seasonDays} season din`,
  quoteCalendarAdd: 'Din add karo',
  quoteCalendarDayLabel: 'Tareekh',
  quoteCalendarKindLabel: 'Qisam',
  quoteCalendarKindHoliday: 'Chhutti',
  quoteCalendarKindSeason: 'Season',
  quoteCalendarNameLabel: 'Naam',
  quoteCalendarNamePlaceholder: 'maslan Eid ul-Fitr',
  quoteCalendarMultiplierLabel: 'Multiplier',
  quoteCalendarMultiplierHint: '1 = wahi rate, 1.25 = chauthai zyada. Booking ke andar sab se ooncha din price tay karta hai.',
  quoteCalendarSave: 'Din save karo',
  quoteCalendarRemoveAria: (name: string, day: string): string => `${day} ka ${name} hatao`,
  quoteCalendarSeasonRange: (name: string, from: string, until: string, n: number, multiplier: string): string =>
    `${name} · ${from} → ${until} · ${n} din · ${multiplier}`,
  quoteCalendarRow: (name: string, day: string, multiplier: string): string => `${name} · ${day} · ${multiplier}`,

  quoteTextTitle: (house: string): string => `${house} — quote`,
  quoteTextFor: (name: string): string => `Naam: ${name}`,
  quoteTextWindow: (from: string, until: string): string => `${from} se ${until} tak`,
  quoteTextDays: (billable: number, calendarDays: number): string =>
    `${billable} bill wale din (calendar pe ${calendarDays})`,
  quoteTextLine: (name: string, qty: number, days: number, rate: string, total: string): string =>
    `${name} × ${qty} · ${days} din · ${rate}/din = ${total}`,
  quoteTextLineUnpriced: (name: string, qty: number): string => `${name} × ${qty} · bina rate`,
  quoteTextMultiplier: (name: string, day: string, multiplier: string): string =>
    `${day} ko ${name}: poori booking pe ${multiplier}`,
  quoteTextTotal: (rupees: string): string => `Total: ${rupees}`,
  quoteTextIndicativeUnpriced: (n: number): string =>
    `Andaazan — ${n} ${cheezein(n)} bina rate, final quote desk se.`,
  quoteTextIndicativeNotConfirmed: 'Andaazan — abhi pakki nahi.',
  quoteTextDeposit: (hint: string): string => `Deposit: ${hint}`,
  quoteTextPayment: (line: string): string => `Payment: ${line}`,
  quoteTextFooter: 'Pakka karne ya kuch badalne ke liye yahin reply karein. Shukriya.',

  // --------------------------------------------------------------- network
  networkPartnersHeading: 'Partner houses',
  networkPartnersSub: 'Jin se saman lete aur jinko dete hain',
  networkPartnersNone: 'Abhi koi partner house nahi — jinhe shaadi ke weekend par call karte ho, unhe add karein.',
  networkAddPartner: 'Partner house add karein',
  networkEditPartner: 'Badlein',
  networkPartnerSheetTitle: 'Partner house',
  networkPartnerNameLabel: 'Naam',
  networkPartnerPhoneLabel: 'Phone (optional)',
  networkPartnerCityLabel: 'Shehar',
  networkPartnerNoteLabel: 'Note (optional)',
  networkPartnerNotePlaceholder: 'jaise: lenses ke liye acha, paise der se deta hai',
  networkPartnerSave: 'Partner save karein',
  networkPartnerBlankName: 'Partner house ka naam chahiye.',
  networkPartnerDuplicate: 'Is naam ka partner pehle se list mein hai — ek house, ek spelling.',
  networkPartnerNotFound: 'Yeh partner house is phone par nahi.',
  networkPartnerOpenLine: (inN: number, outN: number): string =>
    inN + outN === 0 ? 'Kuch open nahi' : `${inN} liya hua · ${outN} diya hua`,
  networkPartnerRemove: 'Yeh partner house hataein',
  networkPartnerRemoveHint: 'Jab tak kuch liya ya diya hua hai, nahi hatega. Hatane ke liye daba ke rakhein.',
  networkPartnerRemoveRefused: (n: number): string =>
    `Is partner ke saath ${n} sub-hire abhi open ${n === 1 ? 'hai' : 'hain'} — pehle band karein.`,
  networkPartnerOpenKhata: 'Unka khata kholein',
  networkPublicHeading: 'Public line',
  networkPublicSub: 'Broadcast par partner group ko jo dikhta hai',
  networkPublicPhoneLabel: 'Public phone (optional)',
  networkPublicPhonePlaceholder: 'jaise: 0300 1234567',
  networkPublicUrlLabel: 'Public tag page ka base (optional)',
  networkPublicUrlPlaceholder: 'jaise: https://tags.example.pk',
  networkPublicUrlHint: 'Abhi koi page nahi — jab tak set na ho, broadcast mein link nahi jata.',
  networkPartnerTitle: 'Partner house',
  networkPartnerCall: 'Call',
  networkPartnerWhatsApp: 'WhatsApp',
  networkPartnerNoSuch: 'Aisa koi partner house nahi.',
  networkBackToPartners: 'Partner houses par wapas',
  networkOpenHeading: 'Open',
  networkOpenSub: (n: number): string => `${n} sub-hire abhi open ${n === 1 ? 'hai' : 'hain'}`,
  networkHistoryHeading: 'History',
  networkHistorySub: (n: number): string => `${n} band sub-hire`,
  networkNothingOpen: 'Abhi kuch liya ya diya hua nahi.',
  networkNothingYet: 'Is house ke saath abhi koi history nahi.',
  networkMoneyHeading: 'Paise',
  networkWeOwe: (amount: string, n: number): string => `${n} sub-hire par hum ${amount} dene hain`,
  networkWeOweNothing: 'Kharcha book par unka kuch nahi banta',
  networkTheyOwe: (amount: string): string => `Unke zimme ${amount} hain`,
  networkTheyOweNothing: 'Unka khata saaf hai',
  networkTheyOweNoKhata: 'Unhon ne abhi hum se kuch liya nahi',
  networkBorrowedStamp: 'liya hua',
  networkLentStamp: 'diya hua',
  networkSubHireStamp: 'sub-hire',
  networkRowIn: (qty: number, product: string, partner: string): string =>
    `${qty} × ${product}, ${partner} se`,
  networkRowOut: (qty: number, product: string, partner: string): string =>
    `${qty} × ${product}, ${partner} ko`,
  networkRowUnit: (code: string): string => `Unit ${code}`,
  networkRowWindow: (from: string, until: string): string => `${from} → ${until}`,
  networkRowUnpriced: 'bina daam',
  networkRowReturned: (when: string): string => `${when} band hua`,
  networkCameBack: 'Wapas aa gaya',
  networkReturned: 'Unhe wapas de diya',
  networkCloseRefusedUnitOut: 'Liya hua unit abhi job par bahar hai — pehle scan in karein.',
  networkCloseRefusedJobOut: (n: number): string =>
    `Sub-hire job par ${n} ${cheezein(n)} abhi bahar — pehle scan in karein.`,
  networkCloseRefusedFuture: 'Wapsi guzri baat hai — aage ki tareekh nahi ho sakti.',
  networkCloseRefusedBeforeStart: 'Yeh sub-hire shuru hone se pehle ki tareekh hai.',
  networkCloseRefusedClosed: 'Pehle se band hai.',
  networkCloseRefusedNotFound: 'Yeh sub-hire is phone par nahi.',
  networkAskMarket: 'Market se poochein',
  networkAskMarketHint: 'Partner houses ko ek message. Kis se poochna hai tick karein, phir har ek ko bhejein — bhejna aap ka kaam hai.',
  networkAskMarketShortage: 'Kam hai',
  networkAskMarketNoPartners: 'Poochne ke liye koi partner house nahi — Settings mein add karein.',
  networkAskMarketPreview: 'Message',
  networkAskMarketSendTo: (name: string): string => `${name} ko bhejein`,
  networkAskMarketSent: 'Bhej diya',
  networkAskMarketNoNumber: 'number nahi',
  networkAskMarketCopy: 'Message copy karein',
  networkAskMarketCopied: 'Copy ho gaya',
  networkAskMarketTheySaidYes: 'Haan keh di — sub-hire likhein',
  networkAskMarketWindowLabel: 'Tareekhein',
  networkSubHireInTitle: 'Sub-hire in likhein',
  networkSubHireInHint: 'Partner se liya hua saman. Serial dene par unit fleet mein liye huay ke taur par aata hai aur label le sakta hai.',
  networkSubHireFromLabel: 'Kis se',
  networkSubHireProductLabel: 'Kya',
  networkSubHireProductSearch: 'Catalogue mein dhoondein',
  networkSubHireProductSearchAria: 'Product dhoondein',
  networkSubHireUnitLabel: 'Kaunsa unit',
  networkSubHireAnyUnit: (n: number, product: string): string => `${n} × ${product}, jo bhi khali ho`,
  networkSubHireQtyLabel: 'Kitne',
  networkSubHireStartLabel: 'Se',
  networkSubHireEndLabel: 'Tak',
  networkSubHireSerialLabel: 'Serial (optional)',
  networkSubHireSerialHint: 'Serial do to unit liye huay ke taur par ban jata hai — tag, scan, ginti sab apne jaisa.',
  networkSubHireCostLabel: 'Tay shuda kharcha (Rs, optional)',
  networkSubHireCostHint: 'Khali matlab bina daam — ginti hogi, zero nahi. Baad mein kharcha book par nipta lein.',
  networkSubHireChargeLabel: 'Tay shuda kiraya (Rs, optional)',
  networkSubHireChargeHint: 'Khali matlab bina daam. Raqam seedha unke khate par jati hai.',
  networkSubHireNoteLabel: 'Note (optional)',
  networkSubHireRecord: 'Sub-hire likhein',
  networkSubHireInDone: (code: string, partner: string): string =>
    `${code} shelf par hai, ${partner} se liya hua.`,
  networkSubHireInDoneNoUnit: (partner: string): string => `Likh liya — ${partner} se liya hua.`,
  networkSubHireAttachLabel: 'Label lagayein',
  networkSubHireRefusal: (reason: string): string =>
    ({
      no_partner: 'Partner house chunein.',
      no_product: 'Product chunein.',
      no_asset: 'Yeh unit is phone par nahi.',
      bad_period: 'Wapsi pickup ke baad honi chahiye.',
      bad_qty: 'Kam az kam ek unit.',
      bad_cost: 'Tay shuda kharcha musbat raqam ho, ya khali.',
      bad_charge: 'Tay shuda kiraya musbat raqam ho, ya khali.',
      serial_needs_one: 'Serial ek unit ka hota hai — ginti 1 rakhein.',
      not_serialized: 'Yeh product ginti wala hai, serial wala nahi — serial khali chhorein.',
      serial_in_fleet: 'Yeh serial pehle se fleet mein hai.',
      asset_gone: 'Yeh unit fleet se nikal chuka hai.',
      asset_borrowed: 'Yeh unit khud liya hua hai — aage nahi de sakte.',
      asset_needs_one: 'Naam wala unit ek hi hota hai.',
      no_customer: 'Is partner ka khata nahi khul saka.',
    }[reason] ?? reason),
  networkLendTitle: 'Partner ko dein',
  networkLendHint: 'Partner ke naam ki job board par aati hai; saman us par waise hi scan out karein jaise client ka.',
  networkLendPartnerLabel: 'Kisko',
  networkLendRecord: 'De dein',
  networkLendThisUnit: 'Partner ko dein',
  networkBorrowedFrom: (partner: string): string => `${partner} se liya hua`,
  networkBorrowedOpenPartner: 'Partner house kholein',
  networkCrewWith: 'Saath',
  networkCrewAdd: 'Crew lagayein',
  networkCrewPickTitle: 'Saath kaun ja raha hai?',
  networkCrewPickHint: 'Naam par tap karein to truck par chadh jayega. Card par chip daba ke rakhein to utar jayega.',
  networkCrewRoleAttendant: 'attendant',
  networkCrewRoleDriver: 'driver',
  networkCrewRemoveAria: (name: string): string => `${name} ko crew se utaarne ke liye daba ke rakhein`,
  networkCrewNobodyLeft: 'Sab pehle se is par hain.',
  networkTellPartners: 'Partner houses ko batayein',
  networkTellPartnersHint: 'Partner group ke liye chhoti line, har house ko alag. Public page set ho to link saath jata hai.',
  networkTellPartnersNoPage: 'Abhi koi public page nahi — line mein link nahi jata.',
  networkThermalPrint: 'Thermal print',
  networkThermalNoPrinter: 'Printer juda nahi — bytes ban gaye, Bluetooth link Android build mein hai.',
  networkThermalSaved: 'Printer bytes save ho gaye (sirf dev).',
  networkThermalFailed: (reason: string): string => `Print nahi hua: ${reason} — dobara try karein, ya parchi share karein.`,
  networkThermalSent: 'Printer ko bhej diya.',

  // --- the pipe (W9) ---
  pipeEnrolTitle: 'Yeh phone enrol karein',
  pipeEnrolSubtitle: 'Ek baar, desk par, WiFi par',
  pipeEnrolHint: 'Owner se code mangwayein. SMS par aata hai aur das minute chalta hai.',
  pipeServerLabel: 'Server ka address',
  pipeServerPlaceholder: 'https://…',
  pipePhoneLabel: 'Aap ka phone number',
  pipePhonePlaceholder: '+92 300 1234567',
  pipeCodeLabel: 'SMS wala code',
  pipeCodePlaceholder: '6 hindse',
  pipeOrgLabel: 'House (sirf agar do jagah kaam karte hain)',
  pipeOrgPlaceholder: 'jo house ka naam owner ne diya',
  pipeDeviceLabelLabel: 'Is phone ka naam',
  pipeDeviceLabelPlaceholder: 'jaise Warehouse phone 1',
  pipePinLabel: 'Aap ka PIN (4 se 6 hindse, abhi optional)',
  pipePinPlaceholder: 'PIN',
  pipeEnrolButton: 'Enrol',
  pipeEnrolling: 'Enrol ho raha hai…',
  pipeEnrolBadCode: 'Yeh code nahi chala. Code das minute chalta hai aur paanch ghalat koshish usay jala deti hain — naya mangwayein.',
  pipeEnrolAmbiguousOrg: 'Yeh number ek se zyada house par hai. Neeche house likhein.',
  pipeEnrolBadPin: 'PIN 4 se 6 hindse ka hota hai.',
  pipeEnrolOffline: 'Server se jawab nahi. Address aur WiFi check karein.',
  pipeEnrolRefused: (why: string): string => `Server ne mana kar diya: ${why}`,
  pipeEnrolClearsDemo: 'Enrol karne se demo warehouse is phone se mit jata hai, queue mein demo scans samet.',
  pipeEnrolled: (name: string): string => `${name} ke naam se enrol ho gaya. Fleet aa rahi hai…`,
  pipeGateTitle: 'Phone kis ke haath mein hai?',
  pipeGateHint: 'Apna naam chunein aur PIN likhein.',
  pipeGateUnlock: 'Kholein',
  pipeGateChecking: 'Check ho raha hai…',
  pipeGateWrongPin: 'Ghalat PIN.',
  pipeGateLockedOut: 'Bohat koshishein — ek minute rukein.',
  pipeGateOfflineUnknown: (name: string): string =>
    `Offline hain, aur ${name} ka PIN is phone par kabhi check nahi hua. Ek baar connect karein, ya kisi aise ko chunein jis ka hua ho.`,
  pipeGateNoPin: 'PIN nahi — aage jane ke liye dabayein',
  pipeGateCheckedOffline: 'PIN offline check hua. Agle sync par server tasdeeq karega.',
  pipePhoneTitle: 'Yeh phone',
  pipePhoneSubtitle: 'Kaun hai, kis se baat karta hai, kya rukah hua hai',
  pipePhoneDoorSub: 'Enrolment, is par log, sync ki tafseel',
  pipeDemoMode: 'Demo mode',
  pipeDemoModeHint: 'Sirf is phone par ek naqli warehouse. Kuch bahar nahi jata. Asli house mein shamil hone ke liye enrol karein.',
  pipeDeviceHeading: 'Device',
  pipeDeviceLine: (label: string, id: string): string => `${label} · ${id}`,
  pipeServerLine: (url: string): string => `${url} se baat karta hai`,
  pipeSessionUntil: (when: string): string => `Session ${when} tak theek hai`,
  pipeTokenInMemory: 'Browser build: session memory mein rehta hai aur reload par chala jata hai. Android build rakhta hai.',
  pipePeopleHeading: 'Is phone par log',
  pipePeopleSub: 'Phone kisi ko dene ke liye naam dabayein',
  pipeHoldingNow: 'abhi is ke paas',
  pipeHasPin: 'PIN laga hai',
  pipeNoPin: 'PIN nahi',
  pipeSyncHeading: 'Sync',
  pipeSyncLastPull: (when: string): string => `Server se aakhri baar ${when} suna`,
  pipeSyncNever: 'Server se abhi tak kuch nahi suna',
  pipeSyncCursor: (n: number): string => `Cursor ${n}`,
  pipeSyncQueue: (n: number): string => `${n} likhai bhejne ke intezar mein`,
  pipeSyncQueueEmpty: 'Bhejne ko kuch nahi',
  pipeSyncLastError: (msg: string): string => `Aakhri shikayat: ${msg}`,
  pipeSyncNow: 'Abhi sync karein',
  pipeSyncing: 'Sync ho raha hai…',
  pipeSessionDead: 'Server ab is phone ko nahi pehchanta. Dobara enrol karein.',
  pipeAttentionHeading: 'Tawajjo chahiye',
  pipeAttentionSub: (n: number): string =>
    `${n} card — server ne inhein mana kiya, aur in ke peeche queue mein jo hai woh in ke saath ruka hai`,
  pipeAttentionNone: 'Kuch ruka hua nahi.',
  pipeAttentionBehind: (n: number): string => `${n} aur is ke peeche`,
  pipeAttentionDismiss: 'Hata dein',
  pipeAttentionDismissed: 'Hata diya. Server ne yeh kabhi nahi liye; us par kuch nahi badla.',
  pipeSignOut: 'Sign out',
  pipeSignOutUnsent: (n: number): string => `${n} likhai abhi bhejne ke intezar mein — pehle sync, phir sign out.`,
  pipeSignOutOffline: 'Sign-out ke liye server chahiye taake asli ho. Connect kar ke dobara koshish karein.',
  pipeSignOutRefused: (why: string): string => `Sign out nahi hua: ${why}`,
  pipeSignedOut: 'Sign out ho gaya. Is phone ne house bhula diya.',
  pipeLiveQueueStatus: (n: number): string =>
    n === 0 ? 'Queue khali · server ke saath sync hai' : `${n} likhai queue mein · server jawab de to jati hai`,
  pipeOpName: (op: string): string => OP_UR[op] ?? op,
}
