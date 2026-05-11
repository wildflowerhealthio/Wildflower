import { Either } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { PatientEntity } from './patient-entity.ts'

const init = (body: string): { body: string; contentType: string; url: string } => ({
  body,
  contentType: 'application/fhir+json',
  url: 'https://example.com/Patient/1',
})

describe('PatientEntity', () => {
  describe('isFoundAt', () => {
    it('should match a Patient URL with numeric ID', () => {
      expect(PatientEntity.isFoundAt('https://r4.smarthealthit.org/Patient/123')).toBe(true)
    })

    it('should match a Patient URL with non-numeric ID', () => {
      expect(PatientEntity.isFoundAt('https://example.com/Patient/abc')).toBe(true)
    })

    it('should not match an Observation URL', () => {
      expect(PatientEntity.isFoundAt('https://example.com/Observation/456')).toBe(false)
    })

    it('should not match a Patient URL with trailing slash', () => {
      expect(PatientEntity.isFoundAt('https://example.com/Patient/123/')).toBe(false)
    })
  })

  describe('parse', () => {
    it('should parse minimal valid Patient JSON', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: '42' })
      const result = new PatientEntity(init(body)).parse()
      expect(Either.isRight(result)).toBe(true)
    })

    it('should parse a Patient with name and gender', () => {
      const body = JSON.stringify({
        resourceType: 'Patient',
        id: '42',
        gender: 'male',
        name: [{ given: ['John'], family: 'Doe' }],
      })
      const result = new PatientEntity(init(body)).parse()
      expect(Either.isRight(result)).toBe(true)
    })

    it('should return Left for malformed JSON', () => {
      const result = new PatientEntity(init('{ not valid json }')).parse()
      expect(Either.isLeft(result)).toBe(true)
    })

    it('should never throw on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = new PatientEntity(init(json)).parse()
          expect(Either.isRight(result) || Either.isLeft(result)).toBe(true)
        })
      )
    })

    it('should return resources containing the decoded patient', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: '42' })
      const result = new PatientEntity(init(body)).parse()

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.resources).toHaveLength(1)
        expect(result.right.resources[0].id).toBe('42')
      }
    })

    it('should return an Observation query link containing the patient ID', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: '42' })
      const result = new PatientEntity(init(body)).parse()

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.links).toHaveLength(1)
        const link = result.right.links[0]
        expect(link._tag).toBe('Open')
        if (link._tag === 'Open') {
          expect(link.href).toContain('Observation')
          expect(link.href).toContain(encodeURIComponent('42'))
          expect(link.href).toContain('3141-9')
        }
      }
    })

    it('should encode special characters in the patient ID link', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: 'special&chars=yes' })
      const result = new PatientEntity(init(body)).parse()

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        const link = result.right.links[0]
        if (link._tag === 'Open') {
          expect(link.href).toContain(encodeURIComponent('special&chars=yes'))
        }
      }
    })
  })

  describe('fields', () => {
    it('should expose body, contentType, and url from init', () => {
      const body = JSON.stringify({ resourceType: 'Patient', id: '42' })
      const entity = new PatientEntity({
        body,
        contentType: 'application/fhir+json',
        url: 'https://example.com/Patient/42',
      })

      expect(entity.body).toBe(body)
      expect(entity.contentType).toBe('application/fhir+json')
      expect(entity.url).toBe('https://example.com/Patient/42')
    })
  })
})
