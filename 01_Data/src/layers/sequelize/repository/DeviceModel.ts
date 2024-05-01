// Copyright (c) 2023 S44, LLC
// Copyright Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache 2.0

import {
  AttributeEnumType,
  type ComponentType,
  DataEnumType,
  type GetVariableResultType,
  MutabilityEnumType,
  type ReportDataType,
  type SetVariableDataType,
  type SetVariableResultType,
  type VariableType,
  CrudRepository,
  SystemConfig,
} from '@citrineos/base';
import { type VariableAttributeQuerystring } from '../../../interfaces/queries/VariableAttribute';
import { SequelizeRepository } from './Base';
import { type IDeviceModelRepository } from '../../../interfaces';
import { Op } from 'sequelize';
import { Component, Evse, Variable, VariableAttribute, VariableCharacteristics } from '../model/DeviceModel';
import { VariableStatus } from '../model/DeviceModel/VariableStatus';
import { ComponentVariable } from '../model/DeviceModel/ComponentVariable';
import { Sequelize } from 'sequelize-typescript';
import { Logger, ILogObj } from 'tslog';

// TODO: Document this

export class SequelizeDeviceModelRepository extends SequelizeRepository<VariableAttribute> implements IDeviceModelRepository {
  variable: CrudRepository<Variable>;
  component: CrudRepository<Component>;
  evse: CrudRepository<Evse>;
  variableCharacteristics: CrudRepository<VariableCharacteristics>;
  componentVariable: CrudRepository<ComponentVariable>;
  variableStatus: CrudRepository<VariableStatus>;

  constructor(
    config: SystemConfig,
    logger?: Logger<ILogObj>,
    namespace = VariableAttribute.MODEL_NAME,
    sequelizeInstance?: Sequelize,
    variable?: CrudRepository<Variable>,
    component?: CrudRepository<Component>,
    evse?: CrudRepository<Evse>,
    componentVariable?: CrudRepository<ComponentVariable>,
    variableCharacteristics?: CrudRepository<VariableCharacteristics>,
    variableStatus?: CrudRepository<VariableStatus>,
  ) {
    super(config, namespace, logger, sequelizeInstance);
    this.variable = variable ? variable : new SequelizeRepository<Variable>(config, Variable.MODEL_NAME, logger, sequelizeInstance);
    this.component = component ? component : new SequelizeRepository<Component>(config, Component.MODEL_NAME, logger, sequelizeInstance);
    this.evse = evse ? evse : new SequelizeRepository<Evse>(config, Evse.MODEL_NAME, logger, sequelizeInstance);
    this.componentVariable = componentVariable ? componentVariable : new SequelizeRepository<ComponentVariable>(config, ComponentVariable.MODEL_NAME, logger, sequelizeInstance);
    this.variableCharacteristics = variableCharacteristics ? variableCharacteristics : new SequelizeRepository<VariableCharacteristics>(config, VariableCharacteristics.MODEL_NAME, logger, sequelizeInstance);
    this.variableStatus = variableStatus ? variableStatus : new SequelizeRepository<VariableStatus>(config, VariableStatus.MODEL_NAME, logger, sequelizeInstance);
  }

  async createOrUpdateDeviceModelByStationId(value: ReportDataType, stationId: string): Promise<VariableAttribute[]> {
    // Doing this here so that no records are created if the data is invalid
    const variableAttributeTypes = value.variableAttribute.map((attr) => attr.type ?? AttributeEnumType.Actual);
    if (variableAttributeTypes.length !== new Set(variableAttributeTypes).size) {
      throw new Error('All variable attributes in ReportData must have different types.');
    }

    const [component, variable] = await this.findOrCreateEvseAndComponentAndVariable(value.component, value.variable, stationId);

    let dataType: DataEnumType | null = null;
    if (value.variableCharacteristics) {
      const [variableCharacteristics, _variableCharacteristicsCreated] = await this.variableCharacteristics.upsert(
        VariableCharacteristics.build({
          ...value.variableCharacteristics,
          variable,
          variableId: variable.id,
        }),
      );
      dataType = variableCharacteristics.dataType;
    }

    return await Promise.all(
      value.variableAttribute.map(async (variableAttribute) => {
        // Even though defaults are set on the VariableAttribute model, those only apply when creating an object
        // So we need to set them here to ensure they are set correctly when updating
        const [savedVariableAttribute, _variableAttributeCreated] = await this.upsert(
          VariableAttribute.build({
            stationId,
            variableId: variable.id,
            componentId: component.id,
            evseDatabaseId: component.evseDatabaseId,
            type: variableAttribute.type ?? AttributeEnumType.Actual,
            dataType,
            value: variableAttribute.value,
            mutability: variableAttribute.mutability ?? MutabilityEnumType.ReadWrite,
            persistent: variableAttribute.persistent ? variableAttribute.persistent : false,
            constant: variableAttribute.constant ? variableAttribute.constant : false,
          }),
        );
        return savedVariableAttribute;
      }),
    );
  }

  async findOrCreateEvseAndComponentAndVariable(componentType: ComponentType, variableType: VariableType, stationId: string): Promise<[Component, Variable]> {
    const component = await this.findOrCreateEvseAndComponent(componentType, stationId);

    const [variable] = await this.variable.readOrCreateByQuery({
      where: { name: variableType.name, instance: variableType.instance ? variableType.instance : null },
      defaults: {
        ...variableType,
      },
    });

    // This can happen asynchronously
    this.componentVariable.readOrCreateByQuery({
      where: { componentId: component.id, variableId: variable.id },
    });

    return [component, variable];
  }

  async findOrCreateEvseAndComponent(componentType: ComponentType, stationId: string): Promise<Component> {
    const evse = componentType.evse ? (await this.evse.readOrCreateByQuery({ where: { id: componentType.evse.id, connectorId: componentType.evse.connectorId ? componentType.evse.connectorId : null } }))[0] : undefined;

    const [component, componentCreated] = await this.component.readOrCreateByQuery({
      where: { name: componentType.name, instance: componentType.instance ? componentType.instance : null },
      defaults: {
        // Explicit assignment because evse field is a relation and is not able to accept a default value
        name: componentType.name,
        instance: componentType.instance,
      },
    });
    // Note: this permits changing the evse related to the component
    if (component.evseDatabaseId !== evse?.databaseId && evse) {
      await this.component.updateByKey({ evseDatabaseId: evse.databaseId }, component.get('id'));
    }

    if (componentCreated) {
      // Excerpt from OCPP 2.0.1 Part 1 Architecture & Topology - 4.2 :
      // "When a Charging Station does not report: Present, Available and/or Enabled
      // the Central System SHALL assume them to be readonly and set to true."
      // These default variables and their attributes are created here if the component is new,
      // and they will be overwritten if they are included in the update
      const defaultComponentVariableNames = ['Present', 'Available', 'Enabled'];
      for (const defaultComponentVariableName of defaultComponentVariableNames) {
        const [defaultComponentVariable, _defaultComponentVariableCreated] = await this.variable.readOrCreateByQuery({ where: { name: defaultComponentVariableName, instance: null } });

        // This can happen asynchronously
        this.componentVariable.readOrCreateByQuery({
          where: { componentId: component.id, variableId: defaultComponentVariable.id },
        });

        await this.create(
          VariableAttribute.build({
            stationId,
            variableId: defaultComponentVariable.id,
            componentId: component.id,
            evseDatabaseId: evse?.databaseId,
            dataType: DataEnumType.boolean,
            value: 'true',
            mutability: MutabilityEnumType.ReadOnly,
          }),
        );
      }
    }

    return component;
  }

  async createOrUpdateByGetVariablesResultAndStationId(getVariablesResult: GetVariableResultType[], stationId: string): Promise<VariableAttribute[]> {
    const savedVariableAttributes: VariableAttribute[] = [];
    for (const result of getVariablesResult) {
      const savedVariableAttribute = (
        await this.createOrUpdateDeviceModelByStationId(
          {
            component: {
              ...result.component,
            },
            variable: {
              ...result.variable,
            },
            variableAttribute: [
              {
                type: result.attributeType,
                value: result.attributeValue,
              },
            ],
          },
          stationId,
        )
      )[0];
      this.variableStatus.create(
        VariableStatus.build(
          {
            value: result.attributeValue,
            status: result.attributeStatus,
            statusInfo: result.attributeStatusInfo,
            variableAttributeId: savedVariableAttribute.get('id'),
          },
          { include: [VariableAttribute] },
        ),
      );
      savedVariableAttributes.push(savedVariableAttribute);
    }
    return savedVariableAttributes;
  }

  async createOrUpdateBySetVariablesDataAndStationId(setVariablesData: SetVariableDataType[], stationId: string): Promise<VariableAttribute[]> {
    const savedVariableAttributes: VariableAttribute[] = [];
    for (const data of setVariablesData) {
      const savedVariableAttribute = (
        await this.createOrUpdateDeviceModelByStationId(
          {
            component: {
              ...data.component,
            },
            variable: {
              ...data.variable,
            },
            variableAttribute: [
              {
                type: data.attributeType,
                value: data.attributeValue,
              },
            ],
          },
          stationId,
        )
      )[0];
      savedVariableAttributes.push(savedVariableAttribute);
    }
    return savedVariableAttributes;
  }

  async updateResultByStationId(result: SetVariableResultType, stationId: string): Promise<VariableAttribute | undefined> {
    const savedVariableAttribute = await super.readAllByQuery(
      {
        where: { stationId, type: result.attributeType ?? AttributeEnumType.Actual },
        include: [
          { model: Component, where: { name: result.component.name, instance: result.component.instance ? result.component.instance : null } },
          { model: Variable, where: { name: result.variable.name, instance: result.variable.instance ? result.variable.instance : null } },
        ],
      }
    ).then((variableAttributes) => variableAttributes.length > 0 ? variableAttributes[0] : undefined);
    if (savedVariableAttribute) {
      await this.variableStatus.create(VariableStatus.build({
        value: savedVariableAttribute.value,
        status: result.attributeStatus,
        statusInfo: result.attributeStatusInfo,
        variableAttributeId: savedVariableAttribute.get('id'),
      }));
      // Reload in order to include the statuses
      return await savedVariableAttribute.reload({
        include: [VariableStatus],
      });
    } else {
      throw new Error('Unable to update variable attribute status...');
    }
  }

  async readAllSetVariableByStationId(stationId: string): Promise<SetVariableDataType[]> {
    const variableAttributeArray = await super.readAllByQuery(
      {
        where: {
          stationId,
          bootConfigSetId: { [Op.ne]: null },
        },
        include: [{ model: Component, include: [Evse] }, Variable],
      }
    );

    return variableAttributeArray.map((variableAttribute) => this.createSetVariableDataType(variableAttribute));
  }

  async readAllByQuery(query: VariableAttributeQuerystring): Promise<VariableAttribute[]> {
    const readQuery = this.constructQuery(query);
    readQuery.include.push(VariableStatus);
    return await super.readAllByQuery(readQuery);
  }

  async existByQuery(query: VariableAttributeQuerystring): Promise<number> {
    return await super.existByQuery(this.constructQuery(query));
  }

  async deleteAllByQuery(query: VariableAttributeQuerystring): Promise<VariableAttribute[]> {
    return await super.deleteAllByQuery(this.constructQuery(query));
  }

  async findComponentAndVariable(componentType: ComponentType, variableType: VariableType): Promise<[Component | null, Variable | null]> {
    const component = await this.component.readAllByQuery({
      where: { name: componentType.name, instance: componentType.instance ? componentType.instance : null },
    }).then((components) => components.length > 0 ? components[0] : null);
    const variable = await this.variable.readAllByQuery({
      where: { name: variableType.name, instance: variableType.instance ? variableType.instance : null },
    }).then((variables) => variables.length > 0 ? variables[0] : null);
    if (variable) {
      const variableCharacteristics = await this.variableCharacteristics.readAllByQuery({
        where: { variableId: variable.get('id') },
      }).then((variableCharacteristics) => variableCharacteristics.length > 0 ? variableCharacteristics[0] : undefined);
      variable.variableCharacteristics = variableCharacteristics ?? undefined;
    }

    return [component, variable];
  }

  /**
   * Private Methods
   */

  private createSetVariableDataType(input: VariableAttribute): SetVariableDataType {
    if (!input.value) {
      throw new Error('Value must be present to generate SetVariableDataType from VariableAttribute');
    } else {
      return {
        attributeType: input.type,
        attributeValue: input.value,
        component: {
          ...input.component,
        },
        variable: {
          ...input.variable,
        },
      };
    }
  }

  private constructQuery(queryParams: VariableAttributeQuerystring): any {
    const evseInclude =
      queryParams.component_evse_id ?? queryParams.component_evse_connectorId
        ? {
            model: Evse,
            where: {
              ...(queryParams.component_evse_id ? { id: queryParams.component_evse_id } : {}),
              ...(queryParams.component_evse_connectorId ? { connectorId: queryParams.component_evse_connectorId } : {}),
            },
          }
        : Evse;
    return {
      where: {
        ...(queryParams.stationId ? { stationId: queryParams.stationId } : {}),
        ...(queryParams.type !== null ? { type: queryParams.type } : {}),
        ...(queryParams.value ? { value: queryParams.value } : {}),
        ...(queryParams.status !== null ? { status: queryParams.status } : {}),
      },
      include: [
        {
          model: Component,
          where: {
            ...(queryParams.component_name ? { name: queryParams.component_name } : {}),
            ...(queryParams.component_instance ? { instance: queryParams.component_instance } : {}),
          },
          include: [evseInclude],
        },
        {
          model: Variable,
          where: {
            ...(queryParams.variable_name ? { name: queryParams.variable_name } : {}),
            ...(queryParams.variable_instance ? { instance: queryParams.variable_instance } : {}),
          },
          include: [VariableCharacteristics],
        },
      ],
    };
  }
}
