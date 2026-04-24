import { Meta, StoryObj } from '@storybook/react'

import { App } from 'scenes/App'
import { urls } from 'scenes/urls'

import { mswDecorator } from '~/mocks/browser'
import { toPaginatedResponse } from '~/mocks/handlers'
import { CohortType } from '~/types'

const cohortMembersQueryHandler = (req: {
    body?: { query?: { kind?: string; source?: { kind?: string } } }
}): [number, Record<string, unknown>] | undefined => {
    const queryKind = req.body?.query?.source?.kind ?? req.body?.query?.kind
    if (queryKind !== 'ActorsQuery') {
        return undefined
    }
    return [
        200,
        {
            columns: ['person_display_name -- Person', 'id', 'created_at'],
            results: [
                [
                    {
                        id: '017cf78e-a849-0000-0000-01fe9b8d7233',
                        distinct_id: '017cf78e-a849-0000-0000-01fe9b8d7233',
                        display_name: 'jane.doe@example.com',
                    },
                    '017cf78e-a849-0000-0000-01fe9b8d7233',
                    '2023-07-03T10:00:00Z',
                ],
                [
                    {
                        id: '01804f4e-0fb7-0000-0000-0db0398f4d98',
                        distinct_id: '01804f4e-0fb7-0000-0000-0db0398f4d98',
                        display_name: 'john.smith@example.com',
                    },
                    '01804f4e-0fb7-0000-0000-0db0398f4d98',
                    '2023-07-03T10:00:00Z',
                ],
                [
                    {
                        id: '0188f346-0564-0000-0000-16bc74aebc20',
                        distinct_id: '0188f346-0564-0000-0000-16bc74aebc20',
                        display_name: 'alice@example.com',
                    },
                    '0188f346-0564-0000-0000-16bc74aebc20',
                    '2023-07-03T10:00:00Z',
                ],
            ],
            hasMore: false,
            is_cached: true,
            cache_key: 'cohort-members-story',
            calculation_trigger: null,
            error: '',
            query_status: null,
            limit: 100,
            offset: 0,
            missing_actors_count: 0,
        },
    ]
}

const meta: Meta = {
    component: App,
    title: 'Scenes-App/People/Cohorts',
    parameters: {
        layout: 'fullscreen',
        viewMode: 'story',
        mockDate: '2023-07-04',
    },
}
export default meta

type Story = StoryObj<{}>

const createCohort = (id: number, name: string, count: number, isStatic: boolean, isCalculating = false): CohortType =>
    ({
        id,
        name,
        count,
        is_static: isStatic,
        is_calculating: isCalculating,
        last_calculation: isStatic ? null : '2023-07-03T10:00:00Z',
        created_by: { id: 1, uuid: 'user-1', distinct_id: 'user-1', first_name: 'Jane', email: 'jane@posthog.com' },
        created_at: '2023-06-15T10:00:00Z',
        deleted: false,
        filters: { properties: { type: 'AND', values: [] } },
        groups: [],
    }) as CohortType

const mockCohorts: CohortType[] = [
    createCohort(1, 'Active users', 1234, false),
    createCohort(2, 'Power users', 567, false),
    createCohort(3, 'Beta testers', 89, true),
]

const cohortApiMocks = {
    '/api/projects/:team_id/actions/': toPaginatedResponse([]),
    '/api/projects/:team_id/cohorts/': toPaginatedResponse(mockCohorts),
}

export const CohortsList: Story = { parameters: { pageUrl: urls.cohorts() } }

export const CohortsWithData: Story = {
    parameters: { pageUrl: urls.cohorts() },
    decorators: [
        mswDecorator({
            get: { '/api/projects/:team_id/cohorts/': toPaginatedResponse(mockCohorts) },
        }),
    ],
}

export const CohortsEmpty: Story = {
    parameters: { pageUrl: urls.cohorts() },
    decorators: [mswDecorator({ get: { '/api/projects/:team_id/cohorts/': toPaginatedResponse([]) } })],
}

export const CohortNew: Story = {
    parameters: { pageUrl: urls.cohort('new') },
    decorators: [mswDecorator({ get: cohortApiMocks })],
}

export const CohortEditDynamic: Story = {
    parameters: { pageUrl: urls.cohort(1) },
    decorators: [mswDecorator({ get: { '/api/projects/:team_id/cohorts/1/': mockCohorts[0], ...cohortApiMocks } })],
}

export const CohortEditStatic: Story = {
    parameters: { pageUrl: urls.cohort(3) },
    decorators: [mswDecorator({ get: { '/api/projects/:team_id/cohorts/3/': mockCohorts[2], ...cohortApiMocks } })],
}

export const CohortEditWithMembers: Story = {
    parameters: {
        pageUrl: urls.cohort(1),
        testOptions: {
            // Waiting for the data table to render, so the copy-to-clipboard button snapshot is stable.
            waitForSelector: '[data-attr="cohort-person-copy-display-name"]',
        },
    },
    decorators: [
        mswDecorator({
            get: { '/api/projects/:team_id/cohorts/1/': mockCohorts[0], ...cohortApiMocks },
            post: { '/api/environments/:team_id/query/:kind/': cohortMembersQueryHandler },
        }),
    ],
}
