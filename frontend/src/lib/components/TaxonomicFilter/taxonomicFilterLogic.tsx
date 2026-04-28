import { BuiltLogic, actions, connect, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { combineUrl } from 'kea-router'
import posthog from 'posthog-js'

import { infiniteListLogic } from 'lib/components/TaxonomicFilter/infiniteListLogic'
import { infiniteListLogicType } from 'lib/components/TaxonomicFilter/infiniteListLogicType'
import {
    hasRecentContext,
    recentTaxonomicFiltersLogic,
    stripRecentContext,
} from 'lib/components/TaxonomicFilter/recentTaxonomicFiltersLogic'
import {
    ExcludedProperties,
    ListStorage,
    SelectedProperties,
    SkeletonItem,
    TaxonomicDefinitionTypes,
    TaxonomicFilterGroup,
    TaxonomicFilterGroupType,
    TaxonomicFilterLogicProps,
    TaxonomicFilterValue,
    isQuickFilterItem,
} from 'lib/components/TaxonomicFilter/types'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { capitalizeFirstLetter, objectsEqual, toParams } from 'lib/utils'
import { getPropertyDefinitionIcon } from 'scenes/data-management/events/DefinitionHeader'
import { dataWarehouseSettingsSceneLogic } from 'scenes/data-warehouse/settings/dataWarehouseSettingsSceneLogic'
import { groupDisplayId } from 'scenes/persons/GroupActorDisplay'
import { projectLogic } from 'scenes/projectLogic'
import { teamLogic } from 'scenes/teamLogic'

import { groupsModel } from '~/models/groupsModel'
import { propertyDefinitionsModel, updatePropertyDefinitions } from '~/models/propertyDefinitionsModel'
import { AnyDataNode, NodeKind } from '~/queries/schema/schema-general'
import { Group, PropertyDefinition } from '~/types'

import { joinsLogic } from 'products/data_warehouse/frontend/shared/logics/joinsLogic'

import { PROPERTY_FILTER_TYPE_TO_TAXONOMIC_FILTER_GROUP_TYPE } from '../PropertyFilters/utils'
import type { taxonomicFilterLogicType } from './taxonomicFilterLogicType'

const PROPERTY_TAXONOMIC_GROUP_TYPES = new Set(Object.values(PROPERTY_FILTER_TYPE_TO_TAXONOMIC_FILTER_GROUP_TYPE))

function indexAfterLastMetaGroup(
    filtered: TaxonomicFilterGroupType[],
    metaGroupOrder: TaxonomicFilterGroupType[]
): number {
    for (let i = metaGroupOrder.length - 1; i >= 0; i--) {
        const idx = filtered.indexOf(metaGroupOrder[i])
        if (idx !== -1) {
            return idx + 1
        }
    }
    return 0
}

const SHORTCUT_TO_PROPERTY_FILTER_GROUP_TYPES = new Set<TaxonomicFilterGroupType>([
    TaxonomicFilterGroupType.PageviewUrls,
    TaxonomicFilterGroupType.PageviewEvents,
    TaxonomicFilterGroupType.Screens,
    TaxonomicFilterGroupType.ScreenEvents,
    TaxonomicFilterGroupType.EmailAddresses,
    TaxonomicFilterGroupType.AutocaptureEvents,
])

import { buildTaxonomicGroups } from 'lib/components/TaxonomicFilter/utils/buildTaxonomicGroups'
import {
    SKELETON_ROWS_PER_GROUP,
    type TopMatchItem,
    redistributeTopMatches,
} from 'lib/components/TaxonomicFilter/utils/redistributeTopMatches'

export {
    DEFAULT_SLOTS_PER_GROUP,
    MAX_TOP_MATCHES_PER_GROUP,
    REDISTRIBUTION_PRIORITY_GROUPS,
    SKELETON_ROWS_PER_GROUP,
    type TopMatchItem,
    redistributeTopMatches,
} from 'lib/components/TaxonomicFilter/utils/redistributeTopMatches'

export { isSkeletonItem, type SkeletonItem } from 'lib/components/TaxonomicFilter/types'

export {
    buildTaxonomicGroups,
    defaultDataWarehousePopoverFields,
    eventTaxonomicGroupProps,
    propertyTaxonomicGroupProps,
} from 'lib/components/TaxonomicFilter/utils/buildTaxonomicGroups'

export const taxonomicFilterLogic = kea<taxonomicFilterLogicType>([
    props({} as TaxonomicFilterLogicProps),
    key((props) => `${props.taxonomicFilterLogicKey}`),
    path(['lib', 'components', 'TaxonomicFilter', 'taxonomicFilterLogic']),
    connect(() => ({
        values: [
            teamLogic,
            ['currentTeamId', 'currentTeam'],
            projectLogic,
            ['currentProjectId'],
            groupsModel,
            ['groupTypes', 'aggregationLabel'],
            dataWarehouseSettingsSceneLogic, // This logic needs to be connected to stop the popover from erroring out
            ['dataWarehouseTables'],
            joinsLogic,
            ['columnsJoinedToPersons'],
            propertyDefinitionsModel,
            ['eventMetadataPropertyDefinitions'],
            featureFlagLogic,
            ['featureFlags'],
        ],
    })),
    actions(() => ({
        moveUp: true,
        moveDown: true,
        selectSelected: true,
        enableMouseInteractions: true,
        tabLeft: true,
        tabRight: true,
        setSearchQuery: (searchQuery: string) => ({ searchQuery }),
        setActiveTab: (activeTab: TaxonomicFilterGroupType) => ({ activeTab }),
        selectItem: (group: TaxonomicFilterGroup, value: TaxonomicFilterValue | null, item: any) => ({
            group,
            value,
            item,
        }),
        infiniteListResultsReceived: (groupType: TaxonomicFilterGroupType, results: ListStorage) => ({
            groupType,
            results,
        }),
        appendTopMatches: (items: (TaxonomicDefinitionTypes & { group: TaxonomicFilterGroupType })[]) => ({
            items,
        }),
    })),
    reducers(({ props, selectors }) => ({
        searchQuery: [
            props.initialSearchQuery || '',
            {
                setSearchQuery: (_, { searchQuery }) => searchQuery,
            },
        ],
        activeTab: [
            (state: any): TaxonomicFilterGroupType => {
                const groupTypes = selectors.taxonomicGroupTypes(state)
                const propsGroupType = selectors.groupType(state)
                // If there's an existing filter type (e.g., SQL expression being edited),
                // use that instead of defaulting to SuggestedFilters
                if (propsGroupType && groupTypes.includes(propsGroupType)) {
                    return propsGroupType
                }
                if (groupTypes.includes(TaxonomicFilterGroupType.SuggestedFilters)) {
                    return TaxonomicFilterGroupType.SuggestedFilters
                }
                const metaTypes = selectors.metaGroupTypes(state)
                return groupTypes.find((t) => !metaTypes.has(t)) ?? groupTypes[0]
            },
            {
                setActiveTab: (_, { activeTab }) => activeTab,
            },
        ],
        mouseInteractionsEnabled: [
            // This fixes a bug with keyboard up/down scrolling when the mouse is over the list.
            // Otherwise shifting list elements cause the "hover" action to be triggered randomly.
            true,
            {
                moveUp: () => false,
                moveDown: () => false,
                setActiveTab: () => true,
                enableMouseInteractions: () => true,
            },
        ],
        topMatchItems: [
            [] as (TaxonomicDefinitionTypes & { group: TaxonomicFilterGroupType })[],
            {
                setSearchQuery: () => [],
                appendTopMatches: (
                    state: (TaxonomicDefinitionTypes & { group: TaxonomicFilterGroupType })[],
                    { items }: { items: (TaxonomicDefinitionTypes & { group: TaxonomicFilterGroupType })[] }
                ) => {
                    const incomingGroup = items[0]?.group
                    if (!incomingGroup) {
                        return state
                    }
                    return [...state.filter((i) => i.group !== incomingGroup), ...items]
                },
            },
        ],
    })),
    selectors({
        selectedItemMeta: [() => [(_, props) => props.filter], (filter) => filter],
        showNumericalPropsOnly: [
            () => [(_, props) => props.showNumericalPropsOnly],
            (showNumericalPropsOnly) => showNumericalPropsOnly ?? false,
        ],
        taxonomicFilterLogicKey: [
            (_, p) => [p.taxonomicFilterLogicKey],
            (taxonomicFilterLogicKey) => taxonomicFilterLogicKey,
        ],
        eventNames: [() => [(_, props) => props.eventNames], (eventNames) => eventNames ?? []],
        schemaColumns: [() => [(_, props) => props.schemaColumns], (schemaColumns) => schemaColumns ?? []],
        maxContextOptions: [
            () => [(_, props) => props.maxContextOptions],
            (maxContextOptions) => maxContextOptions ?? [],
        ],
        dataWarehousePopoverFields: [
            () => [(_, props) => props.dataWarehousePopoverFields],
            (dataWarehousePopoverFields) => dataWarehousePopoverFields ?? [],
        ],
        suggestedFiltersLabel: [
            () => [(_, props) => props.suggestedFiltersLabel],
            (suggestedFiltersLabel) => suggestedFiltersLabel,
        ],
        metadataSource: [
            () => [(_, props) => props.metadataSource],
            (metadataSource): AnyDataNode =>
                metadataSource ?? { kind: NodeKind.HogQLQuery, query: 'select event from events' },
        ],
        excludedProperties: [
            () => [(_, props) => props.excludedProperties],
            (excludedProperties) => (excludedProperties ?? {}) as ExcludedProperties,
        ],
        selectedProperties: [
            () => [(_, props) => props.selectedProperties],
            (selectedProperties) => (selectedProperties ?? {}) as SelectedProperties,
        ],
        propertyAllowList: [
            () => [(_, props) => props.propertyAllowList],
            (propertyAllowList) => propertyAllowList as TaxonomicFilterLogicProps['propertyAllowList'],
        ],
        propertyFilters: [
            (s) => [s.excludedProperties, s.propertyAllowList],
            (excludedProperties, propertyAllowList) => ({ excludedProperties, propertyAllowList }),
        ],
        allowNonCapturedEvents: [
            () => [(_, props) => props.allowNonCapturedEvents],
            (allowNonCapturedEvents: boolean | undefined) => allowNonCapturedEvents ?? false,
        ],
        hideBehavioralCohorts: [
            () => [(_, props) => props.hideBehavioralCohorts],
            (hideBehavioralCohorts: boolean | undefined) => hideBehavioralCohorts ?? false,
        ],
        hogQLExpressionComponentProps: [
            () => [(_, props) => props.hogQLGlobals, (_, props) => props.hogQLExpressionShowBreakdownLabelHint],
            (
                hogQLGlobals: Record<string, any> | undefined,
                showBreakdownLabelHint: boolean | undefined
            ): { globals?: Record<string, any>; showBreakdownLabelHint: boolean } => ({
                globals: hogQLGlobals,
                showBreakdownLabelHint: showBreakdownLabelHint ?? false,
            }),
        ],
        endpointFilters: [
            () => [(_, props) => props.endpointFilters],
            (endpointFilters: Record<string, any>) => endpointFilters,
        ],
        taxonomicGroups: [
            (s) => [
                s.currentTeam,
                s.currentProjectId,
                s.groupAnalyticsTaxonomicGroups,
                s.groupAnalyticsTaxonomicGroupNames,
                s.eventNames,
                s.schemaColumns,
                (_, props) => props.schemaColumnsLoading,
                s.metadataSource,
                s.suggestedFiltersLabel,
                s.propertyFilters,
                s.eventMetadataPropertyDefinitions,
                s.maxContextOptions,
                s.hideBehavioralCohorts,
                s.endpointFilters,
                s.hogQLExpressionComponentProps,
                s.featureFlags,
            ],
            (
                currentTeam,
                projectId,
                groupAnalyticsTaxonomicGroups,
                groupAnalyticsTaxonomicGroupNames,
                eventNames,
                schemaColumns,
                schemaColumnsLoading,
                metadataSource,
                suggestedFiltersLabel,
                propertyFilters,
                eventMetadataPropertyDefinitions,
                maxContextOptions,
                hideBehavioralCohorts,
                endpointFilters,
                hogQLExpressionComponentProps,
                featureFlags
            ): TaxonomicFilterGroup[] =>
                buildTaxonomicGroups({
                    currentTeam,
                    projectId,
                    groupAnalyticsTaxonomicGroups,
                    groupAnalyticsTaxonomicGroupNames,
                    eventNames,
                    schemaColumns,
                    schemaColumnsLoading,
                    metadataSource,
                    suggestedFiltersLabel,
                    propertyFilters,
                    eventMetadataPropertyDefinitions,
                    maxContextOptions,
                    hideBehavioralCohorts,
                    endpointFilters,
                    hogQLExpressionComponentProps,
                    featureFlags,
                }),
        ],
        activeTaxonomicGroup: [
            (s) => [s.activeTab, s.taxonomicGroups],
            (activeTab, taxonomicGroups) => taxonomicGroups.find((g) => g.type === activeTab),
        ],
        metaGroupTypes: [
            (s) => [s.taxonomicGroups],
            (taxonomicGroups: TaxonomicFilterGroup[]): Set<string> =>
                new Set(taxonomicGroups.filter((g) => g.isMetaGroup).map((g) => g.type)),
        ],
        taxonomicGroupTypes: [
            (s, p) => [p.taxonomicGroupTypes, s.taxonomicGroups, s.eventNames],
            (groupTypes, taxonomicGroups, eventNames): TaxonomicFilterGroupType[] => {
                const availableGroupTypes = new Set(taxonomicGroups.map((group) => group.type))
                const resolvedGroupTypes: TaxonomicFilterGroupType[] =
                    groupTypes || taxonomicGroups.map((group) => group.type)

                const mutuallyExclusivePairs: [TaxonomicFilterGroupType, TaxonomicFilterGroupType][] = [
                    [TaxonomicFilterGroupType.PageviewUrls, TaxonomicFilterGroupType.PageviewEvents],
                    [TaxonomicFilterGroupType.Screens, TaxonomicFilterGroupType.ScreenEvents],
                ]
                const excluded = new Set<TaxonomicFilterGroupType>()
                for (const [a, b] of mutuallyExclusivePairs) {
                    if (resolvedGroupTypes.includes(a) && resolvedGroupTypes.includes(b)) {
                        console.warn(`TaxonomicFilter: ${a} and ${b} are mutually exclusive, ignoring ${b}`)
                        excluded.add(b)
                    }
                }

                const filtered = resolvedGroupTypes.filter((groupType) => {
                    if (excluded.has(groupType)) {
                        return false
                    }
                    return availableGroupTypes.has(groupType)
                })

                // SuggestedFilters must be explicitly requested; RecentFilters and
                // PinnedFilters are auto-injected after existing meta groups.
                const metaGroupOrder = [
                    TaxonomicFilterGroupType.SuggestedFilters,
                    TaxonomicFilterGroupType.RecentFilters,
                    TaxonomicFilterGroupType.PinnedFilters,
                ]
                const autoInjectGroups = [
                    TaxonomicFilterGroupType.RecentFilters,
                    TaxonomicFilterGroupType.PinnedFilters,
                ]
                for (const metaType of autoInjectGroups) {
                    if (availableGroupTypes.has(metaType) && !filtered.includes(metaType)) {
                        filtered.splice(indexAfterLastMetaGroup(filtered, metaGroupOrder), 0, metaType)
                    }
                }

                // Promote shortcut groups to top positions (after meta groups)
                const shortcutGroups: TaxonomicFilterGroupType[] = [
                    TaxonomicFilterGroupType.PageviewUrls,
                    TaxonomicFilterGroupType.Screens,
                    TaxonomicFilterGroupType.EmailAddresses,
                    ...(eventNames.includes('$autocapture') ? [TaxonomicFilterGroupType.Elements] : []),
                ]

                const toInsert: TaxonomicFilterGroupType[] = []
                for (const groupType of shortcutGroups) {
                    const idx = filtered.indexOf(groupType)
                    if (idx !== -1) {
                        filtered.splice(idx, 1)
                        toInsert.push(groupType)
                    }
                }

                if (toInsert.length > 0) {
                    filtered.splice(indexAfterLastMetaGroup(filtered, metaGroupOrder), 0, ...toInsert)
                }

                return filtered
            },
        ],
        groupAnalyticsTaxonomicGroupNames: [
            (s) => [s.groupTypes, s.currentTeamId, s.aggregationLabel],
            (groupTypes, teamId, aggregationLabel): TaxonomicFilterGroup[] =>
                Array.from(groupTypes.values()).map((type) => ({
                    name: `${capitalizeFirstLetter(aggregationLabel(type.group_type_index).plural)}`,
                    searchPlaceholder: `${aggregationLabel(type.group_type_index).plural}`,
                    type: `${TaxonomicFilterGroupType.GroupNamesPrefix}_${type.group_type_index}` as unknown as TaxonomicFilterGroupType,
                    endpoint: combineUrl(`api/environments/${teamId}/groups/`, {
                        group_type_index: type.group_type_index,
                    }).url,
                    getPopoverHeader: () => `Group Names`,
                    getName: (group: Group) => groupDisplayId(group.group_key, group.group_properties),
                    getValue: (group: Group) => group.group_key,
                    groupTypeIndex: type.group_type_index,
                })),
        ],
        groupAnalyticsTaxonomicGroups: [
            (s) => [s.groupTypes, s.currentProjectId, s.aggregationLabel],
            (groupTypes, projectId, aggregationLabel): TaxonomicFilterGroup[] =>
                Array.from(groupTypes.values()).map((type) => ({
                    name: `${capitalizeFirstLetter(aggregationLabel(type.group_type_index).singular)} properties`,
                    searchPlaceholder: `${aggregationLabel(type.group_type_index).singular} properties`,
                    type: `${TaxonomicFilterGroupType.GroupsPrefix}_${type.group_type_index}` as unknown as TaxonomicFilterGroupType,
                    endpoint: combineUrl(`api/projects/${projectId}/property_definitions`, {
                        type: 'group',
                        group_type_index: type.group_type_index,
                        exclude_hidden: true,
                    }).url,
                    valuesEndpoint: (key) =>
                        `api/projects/${projectId}/groups/property_values?${toParams({
                            key,
                            group_type_index: type.group_type_index,
                        })}`,
                    getName: (group) => group.name,
                    getValue: (group) => group.name,
                    getPopoverHeader: () => `Property`,
                    getIcon: getPropertyDefinitionIcon,
                    groupTypeIndex: type.group_type_index,
                })),
        ],
        infiniteListLogics: [
            (s) => [s.taxonomicGroupTypes, (_, props) => props],
            (taxonomicGroupTypes, props): Record<string, BuiltLogic<infiniteListLogicType>> =>
                Object.fromEntries(
                    taxonomicGroupTypes.map((groupType) => [
                        groupType,
                        infiniteListLogic.build({
                            ...props,
                            listGroupType: groupType,
                        }),
                    ])
                ),
        ],
        anyGroupLoading: [
            (s) => [
                (state, props) => {
                    const logics = s.infiniteListLogics(state, props)
                    const meta = s.metaGroupTypes(state, props)
                    return Object.entries(logics).some(
                        ([type, logic]) =>
                            !meta.has(type) && logic.isMounted() && logic.selectors.isLoading(state, logic.props)
                    )
                },
            ],
            (anyGroupLoading: boolean) => anyGroupLoading,
        ],
        loadingGroupTypes: [
            (s) => [
                (state, props) => {
                    const logics = s.infiniteListLogics(state, props)
                    const meta = s.metaGroupTypes(state, props)
                    return Object.entries(logics)
                        .filter(
                            ([type, logic]) =>
                                !meta.has(type) && logic.isMounted() && logic.selectors.isLoading(state, logic.props)
                        )
                        .map(([type]) => type)
                        .join(',')
                },
            ],
            (loadingGroupTypesString: string): TaxonomicFilterGroupType[] =>
                loadingGroupTypesString ? (loadingGroupTypesString.split(',') as TaxonomicFilterGroupType[]) : [],
        ],
        infiniteListCounts: [
            (s) => [
                (state, props) =>
                    Object.fromEntries(
                        Object.entries(s.infiniteListLogics(state, props)).map(([groupType, logic]) => [
                            groupType,
                            logic.isMounted() ? logic.selectors.totalListCount(state, logic.props) : 0,
                        ])
                    ),
            ],
            (infiniteListCounts) => infiniteListCounts,
            { resultEqualityCheck: objectsEqual },
        ],
        value: [() => [(_, props) => props.value], (value) => value],
        groupType: [() => [(_, props) => props.groupType], (groupType) => groupType],
        currentTabIndex: [
            (s) => [s.taxonomicGroupTypes, s.activeTab],
            (groupTypes, activeTab) => Math.max(groupTypes.indexOf(activeTab || ''), 0),
        ],
        searchPlaceholder: [
            (s) => [s.taxonomicGroups, s.taxonomicGroupTypes],
            (allTaxonomicGroups, searchGroupTypes) => {
                if (searchGroupTypes.length > 1) {
                    searchGroupTypes = searchGroupTypes.filter(
                        (type) =>
                            !type.startsWith(TaxonomicFilterGroupType.GroupsPrefix) &&
                            !type.startsWith(TaxonomicFilterGroupType.GroupNamesPrefix)
                    )
                }
                const names = searchGroupTypes
                    .map((type) => {
                        const taxonomicGroup = allTaxonomicGroups.find(
                            (tGroup) => tGroup.type == type
                        ) as TaxonomicFilterGroup
                        return taxonomicGroup.searchPlaceholder
                    })
                    .filter(Boolean)
                return names
                    .filter((a) => !!a)
                    .map(
                        (name, index) =>
                            `${index !== 0 ? (index === searchGroupTypes.length - 1 ? ' or ' : ', ') : ''}${name}`
                    )
                    .join('')
            },
        ],
        redistributedTopMatchItems: [
            (s) => [s.topMatchItems, s.taxonomicGroupTypes, s.metaGroupTypes],
            (
                topMatchItems: TopMatchItem[],
                taxonomicGroupTypes: TaxonomicFilterGroupType[],
                metaGroupTypes: Set<string>
            ): TopMatchItem[] => {
                const nonMetaGroups = taxonomicGroupTypes.filter((t) => !metaGroupTypes.has(t))
                return redistributeTopMatches(topMatchItems, nonMetaGroups.length, nonMetaGroups)
            },
        ],
        topMatchItemsWithSkeletons: [
            (s) => [
                s.redistributedTopMatchItems,
                s.taxonomicGroupTypes,
                s.loadingGroupTypes,
                s.taxonomicGroups,
                s.searchQuery,
                s.metaGroupTypes,
            ],
            (
                redistributed: TopMatchItem[],
                taxonomicGroupTypes: TaxonomicFilterGroupType[],
                loadingGroupTypes: TaxonomicFilterGroupType[],
                taxonomicGroups: TaxonomicFilterGroup[],
                searchQuery: string,
                metaGroupTypes: Set<string>
            ): (TopMatchItem | SkeletonItem)[] => {
                if (!searchQuery) {
                    return redistributed
                }

                const nonMetaGroups = taxonomicGroupTypes.filter((t) => !metaGroupTypes.has(t))

                const result: (TopMatchItem | SkeletonItem)[] = []
                for (const groupType of nonMetaGroups) {
                    const groupItems = redistributed.filter((item) => item.group === groupType)
                    if (groupItems.length > 0) {
                        result.push(...groupItems)
                    } else if (loadingGroupTypes.includes(groupType)) {
                        const groupDef = taxonomicGroups.find((g) => g.type === groupType)
                        const groupName = groupDef?.name ?? groupType
                        for (let i = 0; i < SKELETON_ROWS_PER_GROUP; i++) {
                            result.push({ _skeleton: true, group: groupType, groupName })
                        }
                    }
                }
                return result
            },
        ],
    }),
    listeners(({ actions, values, props }) => ({
        selectItem: ({ group, value, item }) => {
            if (item) {
                if (isQuickFilterItem(item)) {
                    posthog.capture('taxonomic suggested filter selected', {
                        query: values.searchQuery,
                        filterName: item.name,
                        propertyKey: item.propertyKey,
                        operator: item.operator,
                        filterValue: item.filterValue,
                        propertyFilterType: item.propertyFilterType,
                        eventName: item.eventName,
                        // Distinguish shortcuts picked from the dedicated SuggestedFilters tab
                        // (where cross-group top matches aggregate) from those picked inline in
                        // their origin group tab. Use activeTab, not group.type — `group` has
                        // already been resolved to the shortcut's origin group by getItemGroup.
                        source:
                            values.activeTab === TaxonomicFilterGroupType.SuggestedFilters
                                ? 'suggested_filters_tab'
                                : 'keyword_shortcut',
                    })
                }

                // Record to recents (deferred to avoid render loop).
                // Skip property groups — these are just the key-picking step;
                // the complete filter (with operator + value) is recorded by propertyFilterLogic.
                // Skip QuickFilterItem shortcuts — they are synthetic, not real data definitions.
                const sourceGroupType = hasRecentContext(item) ? item._recentContext.sourceGroupType : group.type
                const hasCompletePropertyFilter = hasRecentContext(item) && item._recentContext.propertyFilter
                const isRecordedByPropertyFilterLogic =
                    !hasCompletePropertyFilter &&
                    (PROPERTY_TAXONOMIC_GROUP_TYPES.has(sourceGroupType) ||
                        SHORTCUT_TO_PROPERTY_FILTER_GROUP_TYPES.has(sourceGroupType) ||
                        sourceGroupType.startsWith(TaxonomicFilterGroupType.GroupsPrefix))

                if (!isRecordedByPropertyFilterLogic && !isQuickFilterItem(item)) {
                    setTimeout(() => {
                        if (recentTaxonomicFiltersLogic.isMounted()) {
                            const stripped = hasRecentContext(item) ? stripRecentContext(item) : item
                            const cleanItem = { name: stripped.name, ...(stripped.id ? { id: stripped.id } : {}) }
                            const sourceGroupName = hasRecentContext(item)
                                ? item._recentContext.sourceGroupName
                                : group.name
                            const propertyFilterFromRecent = hasRecentContext(item)
                                ? item._recentContext.propertyFilter
                                : undefined
                            recentTaxonomicFiltersLogic.actions.recordRecentFilter(
                                sourceGroupType,
                                sourceGroupName,
                                value,
                                cleanItem,
                                teamLogic.values.currentTeamId ?? undefined,
                                propertyFilterFromRecent
                            )
                        }
                    }, 0)
                }

                props.onChange?.(group, value, item)
            } else if (group.type === TaxonomicFilterGroupType.HogQLExpression && value) {
                props.onChange?.(group, value, item)
            } else if (props.onEnter) {
                props.onEnter(values.searchQuery)
                return
            }
            actions.setSearchQuery('')
        },

        moveUp: async (_, breakpoint) => {
            if (values.activeTab) {
                infiniteListLogic({
                    ...props,
                    listGroupType: values.activeTab,
                }).actions.moveUp()
            }
            await breakpoint(100)
            actions.enableMouseInteractions()
        },

        moveDown: async (_, breakpoint) => {
            if (values.activeTab) {
                infiniteListLogic({
                    ...props,
                    listGroupType: values.activeTab,
                }).actions.moveDown()
            }
            await breakpoint(100)
            actions.enableMouseInteractions()
        },

        selectSelected: async (_, breakpoint) => {
            if (values.activeTab) {
                infiniteListLogic({
                    ...props,
                    listGroupType: values.activeTab,
                }).actions.selectSelected()
            }
            await breakpoint(100)
            actions.enableMouseInteractions()
        },

        tabLeft: () => {
            const { currentTabIndex, taxonomicGroupTypes, infiniteListCounts } = values
            for (let i = 1; i < taxonomicGroupTypes.length; i++) {
                const newIndex = (currentTabIndex - i + taxonomicGroupTypes.length) % taxonomicGroupTypes.length
                if (infiniteListCounts[taxonomicGroupTypes[newIndex]] > 0) {
                    actions.setActiveTab(taxonomicGroupTypes[newIndex])
                    return
                }
            }
        },

        tabRight: () => {
            const { currentTabIndex, taxonomicGroupTypes, infiniteListCounts } = values
            for (let i = 1; i < taxonomicGroupTypes.length; i++) {
                const newIndex = (currentTabIndex + i) % taxonomicGroupTypes.length
                if (infiniteListCounts[taxonomicGroupTypes[newIndex]] > 0) {
                    actions.setActiveTab(taxonomicGroupTypes[newIndex])
                    return
                }
            }
        },

        setSearchQuery: async ({ searchQuery }, breakpoint) => {
            const { activeTaxonomicGroup } = values

            await breakpoint(500)
            if (searchQuery) {
                posthog.capture('taxonomic_filter_search_query', {
                    searchQuery,
                    groupType: activeTaxonomicGroup?.type,
                })
            }
        },

        infiniteListResultsReceived: ({ groupType, results }) => {
            if (groupType && !values.metaGroupTypes.has(groupType)) {
                const subLogic = values.infiniteListLogics[groupType]
                if (subLogic?.isMounted()) {
                    const matches = subLogic.values.topMatchesForQuery
                        .filter(Boolean)
                        .map((m) => ({ ...m, group: groupType }))
                    if (matches.length > 0) {
                        actions.appendTopMatches(matches)
                    }
                }
            }

            // Update app-wide cached property metadata
            if (
                results.count > 0 &&
                (groupType === TaxonomicFilterGroupType.EventProperties ||
                    groupType === TaxonomicFilterGroupType.PersonProperties ||
                    groupType === TaxonomicFilterGroupType.NumericalEventProperties)
            ) {
                const propertyDefinitions: PropertyDefinition[] = results.results as PropertyDefinition[]
                const apiType = groupType === TaxonomicFilterGroupType.PersonProperties ? 'person' : 'event'
                const newPropertyDefinitions = Object.fromEntries(
                    propertyDefinitions.map((propertyDefinition) => [
                        `${apiType}/${propertyDefinition.name}`,
                        propertyDefinition,
                    ])
                )
                updatePropertyDefinitions(newPropertyDefinitions)
            }
        },
    })),
])
