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
const KHARCHA_UR: Record<string, string> = {
  repair: 'marammat',
  sub_hire: 'sub-hire',
  purchase: 'khareedari',
  transport: 'transport',
  consumables: 'chhota saman',
  misc: 'deegar',
}

export const STR_UR: StrTable = {
  // ---------------------------------------------------------------- common
  commonTabToday: 'Aaj',
  commonTabGear: 'Saaman',
  commonTabKitList: 'Kit list',
  commonTabLabels: 'Labels',
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
  closedJobsDoor: 'Band jobs',
  closedJobsReopen: 'Dobara kholein',
  closedJobsClosedOn: (date: string): string => `${date} ko band hui`,
  closedJobsNeverCameBack: (n: number): string =>
    n === 1 ? '1 cheez kabhi wapas nahi aayi' : `${n} cheezein kabhi wapas nahi aayin`,

  // ----------------------------------------------------------------- fleet
  fleetGoneHeading: 'Yeh cheez fleet se nikal gayi',
  fleetDispositionWord: (d: string): string =>
    ({ lost: 'gum', stolen: 'chori', sold: 'bik gayi', retired: 'retire' }[d] ?? d),
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
}
