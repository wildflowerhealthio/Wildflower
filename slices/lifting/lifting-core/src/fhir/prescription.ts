import { Array as Arr, Data, DateTime, Either, Option, pipe, Schema } from 'effect'
import type { IdentifierAndReference } from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'

import { describeProblem } from '../plan.ts'
import {
  outOfRangePrescriptionFieldsOf,
  type Prescription,
  type PrescriptionOutOfRange,
  PrescriptionProblem,
} from '../prescription.ts'
import type { PrescriptionProgress } from '../progression.ts'
import {
  countAmong,
  countConcept,
  exactlyOne,
  exerciseConcept,
  exerciseOf,
  ExerciseUnreadable,
  liftingFeatureConcept,
  loadAmong,
  loadConcept,
  type LiftingMeasure,
  LiftingMeasureCode,
  referenceOf,
  referenceTo,
} from './elements.ts'

/** A decoded FHIR R4 `ServiceRequest`. */
type ServiceRequestResource = ServiceRequest.Type

/** A `ServiceRequest.status`. */
type RequestStatus = typeof ServiceRequest.StatusSchema.Type

/** Options for {@link prescriptionToFhir}. */
interface PrescriptionToFhirOptions {
  /** The `ServiceRequest.id` to write; the app mints it. */
  readonly requestId: string
  /** The lifter the prescription is for, as a literal reference (`Patient/p-1`). */
  readonly subject: string
  /** The canonical `url` of the `PlanDefinition` the prescription follows, written as `instantiatesCanonical`. */
  readonly planUrl: string
  /** When the prescription was issued, written as `authoredOn`. */
  readonly authoredOn: DateTime.Utc
  /** The id of the closed request this one takes the place of, written as `replaces`; `None` for a first prescription. */
  readonly replaces: Option.Option<string>
}

/**
 * A prescription as it is stored: the prescription, the id its
 * `ServiceRequest` is stored under, the plan it follows and its status —
 * what an app needs to log sets against it, progress it, and close it.
 */
interface StoredPrescription {
  /** The prescription the resource holds. */
  readonly prescription: Prescription
  /** The `ServiceRequest.id` the prescription is stored under. */
  readonly requestId: string
  /** The `PlanDefinition.url` the request instantiates. */
  readonly planUrl: string
  /** `ServiceRequest.status`: `active` while the lifter works at this load. */
  readonly status: RequestStatus
}

/** One reason {@link prescriptionFromFhir} could not read a `ServiceRequest`. */
type PrescriptionReadProblem =
  | ExerciseUnreadable
  | PrescriptionOutOfRange
  | Data.TaggedEnum<{
      /** The `ServiceRequest` has no `id`, so nothing can be logged against it or close it. */
      RequestIdMissing: Record<never, never>
      /** There is no single `instantiatesCanonical`, so the plan it follows is unknown. */
      PlanUrlUnreadable: Record<never, never>
      /**
       * No single `orderDetail` measures `measure`, or its value extension is
       * missing or of the wrong shape (`load` an `[lb_av]` or `kg` quantity
       * with no comparator, `sets` and `reps` a `valueInteger`). A value of
       * the right shape but out of range is a `PrescriptionOutOfRange`.
       */
      MeasureUnreadable: { readonly measure: LiftingMeasure }
    }>

/**
 * Constructors and matchers for {@link PrescriptionReadProblem}. Its
 * `ExerciseUnreadable` and `PrescriptionOutOfRange` variants are the shared
 * ones — the same problems the other readers and `prescribe` report.
 */
const PrescriptionReadProblem = Data.taggedEnum<PrescriptionReadProblem>()

/** {@link prescriptionFromFhir} could not read a `ServiceRequest`, listing every problem it found. */
class PrescriptionUnreadable extends Data.TaggedError('PrescriptionUnreadable')<{
  /** Every reason the prescription could not be read. */
  readonly problems: Arr.NonEmptyReadonlyArray<PrescriptionReadProblem>
}> {
  // Data.TaggedError leaves `.message` empty by default; name the problems so
  // a logged or thrown refusal says what was wrong.
  override get message(): string {
    return `prescription unreadable: ${this.problems.map(describeProblem).join('; ')}`
  }
}

/** A decoded `ServiceRequest` with every optional slot empty, for the prescription's fields to be spread onto. */
const emptyRequest: ServiceRequestResource = Schema.decodeSync(ServiceRequest.Schema)({
  resourceType: 'ServiceRequest',
  status: 'active',
  intent: 'plan',
  subject: {},
})

/** The request for a prescription, its subject already a reference. */
const requestFor = (
  prescription: Prescription,
  options: Omit<PrescriptionToFhirOptions, 'subject'> & {
    readonly subject: IdentifierAndReference.ReferenceType
  }
): ServiceRequestResource => ({
  ...emptyRequest,
  id: options.requestId,
  status: 'active',
  intent: 'plan',
  priority: 'routine',
  category: [liftingFeatureConcept],
  code: exerciseConcept(prescription.exercise),
  orderDetail: [
    loadConcept(prescription.load),
    countConcept(LiftingMeasureCode.Sets, prescription.sets),
    countConcept(LiftingMeasureCode.Reps, prescription.reps),
  ],
  subject: options.subject,
  instantiatesCanonical: [options.planUrl],
  replaces: Option.match(options.replaces, {
    onNone: () => [],
    onSome: (replaced) => [referenceTo('ServiceRequest', replaced)],
  }),
  authoredOn: DateTime.formatIso(options.authoredOn),
})

/**
 * A prescription as a FHIR R4 `ServiceRequest`: `active`, intent `plan`,
 * priority `routine`, filed under the `strength-training` feature
 * `category`, the exercise as its `code`, and one `orderDetail` per measure —
 * `load` as a UCUM `valueQuantity`, `sets` and `reps` as a `valueInteger`,
 * each in the concept's {@link WildflowerExtension.LiftingMeasureValue}
 * extension — instantiating the plan's canonical url, replacing the request
 * it succeeds, and `authoredOn` when it was issued.
 *
 * @param prescription - The prescription to write
 * @param options - The id the app minted for the resource, its subject, the
 *   plan it follows, when it was issued, and the request it replaces
 * @returns The decoded `ServiceRequest`, ready to encode
 *
 * @remarks
 * Always `active`: a request is issued to be worked at. It is closed —
 * `completed` when its session is met, `revoked` on a deload or a change of
 * program — by {@link prescriptionProgressToFhir} and {@link revokedRequest},
 * which rewrite the stored resource's status.
 */
const prescriptionToFhir = (
  prescription: Prescription,
  options: PrescriptionToFhirOptions
): ServiceRequestResource =>
  requestFor(prescription, { ...options, subject: referenceOf(options.subject) })

/** Every reason a field could not be read; never empty. */
type Problems = Arr.NonEmptyReadonlyArray<PrescriptionReadProblem>

/** The prescription, or each of its fields out of range as `prescribe`'s own `PrescriptionOutOfRange`. */
const inRange = (prescription: Prescription): Either.Either<Prescription, Problems> =>
  Arr.match(outOfRangePrescriptionFieldsOf(prescription), {
    onEmpty: () => Either.right(prescription),
    onNonEmpty: (fields) =>
      Either.left(
        Arr.map(fields, (field) => PrescriptionProblem.PrescriptionOutOfRange({ field }))
      ),
  })

/**
 * The stored prescription a FHIR R4 `ServiceRequest` written by
 * {@link prescriptionToFhir} holds.
 *
 * @param request - A decoded `ServiceRequest`
 * @returns The {@link StoredPrescription}, or {@link PrescriptionUnreadable}
 *   listing every {@link PrescriptionReadProblem}: no `id`; no single
 *   `instantiatesCanonical`; no single exercise coding (with its display); not
 *   exactly one `load`, `sets` or `reps` order detail carrying a value in
 *   range; or a field out of the range `prescribe` accepts
 *
 * @remarks
 * All-or-nothing and "exactly one": a request with a missing or duplicated
 * measure cannot be followed unambiguously, so it is refused rather than read
 * with a default or the first match. Its `status` is read, not checked — the
 * app searches for `status=active` and this reader passes the answer on.
 * `subject`, `category` and `replaces` are not read: the app scopes its
 * search by patient and category, and lineage is for FHIR readers.
 */
const prescriptionFromFhir = (
  request: ServiceRequestResource
): Either.Either<StoredPrescription, PrescriptionUnreadable> => {
  const reads = {
    requestId: Either.fromNullable(request.id, () =>
      Arr.of<PrescriptionReadProblem>(PrescriptionReadProblem.RequestIdMissing())
    ),
    planUrl: Either.fromOption(exactlyOne(request.instantiatesCanonical), () =>
      Arr.of<PrescriptionReadProblem>(PrescriptionReadProblem.PlanUrlUnreadable())
    ),
    exercise: Either.fromOption(exerciseOf(request.code), () => Arr.of(ExerciseUnreadable())),
    load: Either.fromOption(loadAmong(request.orderDetail), () =>
      Arr.of(PrescriptionReadProblem.MeasureUnreadable({ measure: LiftingMeasureCode.Load }))
    ),
    sets: Either.fromOption(countAmong(request.orderDetail, LiftingMeasureCode.Sets), () =>
      Arr.of(PrescriptionReadProblem.MeasureUnreadable({ measure: LiftingMeasureCode.Sets }))
    ),
    reps: Either.fromOption(countAmong(request.orderDetail, LiftingMeasureCode.Reps), () =>
      Arr.of(PrescriptionReadProblem.MeasureUnreadable({ measure: LiftingMeasureCode.Reps }))
    ),
  }
  return pipe(
    Arr.match(Arr.getLefts(Object.values(reads)).flat(), {
      onNonEmpty: (problems): Either.Either<RequestReads, Problems> => Either.left(problems),
      onEmpty: () => Either.all(reads),
    }),
    Either.flatMap(({ requestId, planUrl, exercise, load, sets, reps }) =>
      Either.map(inRange({ exercise, load, sets, reps }), (prescription): StoredPrescription => ({
        prescription,
        requestId,
        planUrl,
        status: request.status,
      }))
    ),
    Either.mapLeft((problems) => new PrescriptionUnreadable({ problems }))
  )
}

/** What {@link prescriptionFromFhir} reads off a request before checking the ranges. */
interface RequestReads {
  readonly requestId: string
  readonly planUrl: string
  readonly exercise: Prescription['exercise']
  readonly load: Prescription['load']
  readonly sets: number
  readonly reps: number
}

/** Options for {@link prescriptionProgressToFhir}. */
interface ProgressToFhirOptions {
  /** The `ServiceRequest.id` to write the next prescription under, when one is issued; the app mints it. */
  readonly nextRequestId: string
  /** When the step was taken: the next request's `authoredOn`. */
  readonly authoredOn: DateTime.Utc
}

/** The resources a progression step writes: the current request, closed or not, and the next one when issued. */
interface ProgressResources {
  /** The current request: `completed` after an increment, `revoked` after a deload, unchanged on a hold. */
  readonly current: ServiceRequestResource
  /** The next prescription's request, replacing the current one; `None` on a hold. */
  readonly next: Option.Option<ServiceRequestResource>
}

/** The status each decision closes the current request with; a hold closes nothing. */
const CLOSING_STATUS_OF: {
  readonly [Decision in PrescriptionProgress['decision']]: Option.Option<RequestStatus>
} = {
  increment: Option.some('completed'),
  deload: Option.some('revoked'),
  hold: Option.none(),
}

/**
 * The `ServiceRequest`s that apply a progression step: the current request
 * closed as the decision says, and the next prescription's request.
 *
 * @param current - The decoded `ServiceRequest` the step was taken over
 * @param progress - `progressPrescription`'s result for it
 * @param options - The id the app minted for the next request, and when the step was taken
 * @returns The current request `completed` (increment) or `revoked` (deload)
 *   and the next request replacing it, under `nextRequestId`, with the same
 *   subject and plan; or the current request untouched and no next one, on a
 *   hold. {@link PrescriptionUnreadable} when `current` has no `id` or no
 *   single `instantiatesCanonical` to carry forward.
 */
const prescriptionProgressToFhir = (
  current: ServiceRequestResource,
  progress: PrescriptionProgress,
  options: ProgressToFhirOptions
): Either.Either<ProgressResources, PrescriptionUnreadable> =>
  Either.map(prescriptionFromFhir(current), (stored) =>
    Option.match(
      Option.all({ status: CLOSING_STATUS_OF[progress.decision], next: progress.next }),
      {
        onNone: () => ({ current, next: Option.none() }),
        onSome: ({ status, next }) => ({
          current: { ...current, status },
          next: Option.some(
            requestFor(next, {
              requestId: options.nextRequestId,
              subject: current.subject,
              planUrl: stored.planUrl,
              authoredOn: options.authoredOn,
              replaces: Option.some(stored.requestId),
            })
          ),
        }),
      }
    )
  )

/**
 * A request closed as abandoned — what a change of program does to every
 * `active` request of the plan being left.
 */
const revokedRequest = (current: ServiceRequestResource): ServiceRequestResource => ({
  ...current,
  status: 'revoked',
})

export {
  prescriptionFromFhir,
  prescriptionProgressToFhir,
  PrescriptionReadProblem,
  prescriptionToFhir,
  PrescriptionUnreadable,
  revokedRequest,
}
export type {
  PrescriptionToFhirOptions,
  ProgressResources,
  ProgressToFhirOptions,
  RequestStatus,
  ServiceRequestResource,
  StoredPrescription,
}
