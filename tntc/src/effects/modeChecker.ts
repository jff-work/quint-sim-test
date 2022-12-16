/* ----------------------------------------------------------------------------------
 * Copyright (c) Informal Systems 2022. All rights reserved.
 * Licensed under the Apache 2.0.
 * See License.txt in the project root for license information.
 * --------------------------------------------------------------------------------- */

/**
 * Check that all definitions in a module have correctly annotated modes
 * according to inferred effects
 *
 * @author Gabriela Moreira
 *
 * @module
 */

import { Either, left, right } from '@sweet-monads/either'
import isEqual from 'lodash.isequal'
import { ErrorTree } from '../errorTree'
import { definitionToString, qualifierToString } from '../IRprinting'
import { IRVisitor, walkModule } from '../IRVisitor'
import { OpQualifier, TntModule, TntOpDef } from '../tntIr'
import { ArrowEffect, ConcreteEffect, Effect, Variables, isAction, isState, isTemporal } from './base'
import { EffectVisitor, walkEffect } from './EffectVisitor'
import { effectToString } from './printing'

/**
 * Matches annotated modes for each definition with its inferred effect. Returns
 * errors for incorrect annotations and suggestions for annotations that could
 * be more strict.
 *
 * @param tntModule: the module to be checked
 * @param effects: the map from expression ids to their inferred effects
 *
 * @returns The mode errors, if any is found. Otherwise, a map with potential suggestions.
 */
export function checkModes(
  tntModule: TntModule, effects: Map<bigint, Effect>
): Either<Map<bigint, ErrorTree>, Map<bigint, OpQualifier>> {
  const visitor = new ModeCheckerVisitor(effects)
  walkModule(visitor, tntModule)
  if (visitor.errors.size > 0) {
    return left(visitor.errors)
  } else {
    return right(visitor.suggestions)
  }
}

class ModeCheckerVisitor implements IRVisitor {
  public errors: Map<bigint, ErrorTree> = new Map<bigint, ErrorTree>()
  public suggestions: Map<bigint, OpQualifier> = new Map<bigint, OpQualifier>()
  effects: Map<bigint, Effect>
  modeFinderVisitor: ModeFinderVisitor = new ModeFinderVisitor()

  constructor(effects: Map<bigint, Effect>) {
    this.effects = effects
  }

  exitOpDef(def: TntOpDef) {
    const effect = this.effects.get(def.id)
    if (!effect) {
      return
    }

    walkEffect(this.modeFinderVisitor, effect)
    const mode = this.modeFinderVisitor.currentMode
    this.modeFinderVisitor.currentMode = 'pureval'

    if (mode === def.qualifier) {
      return
    }

    const generalMode = commonMode(mode, def.qualifier)

    if (generalMode === mode) {
      this.errors.set(def.id, {
        location: `Checking modes for ${definitionToString(def)}`,
        message: `Expected ${mode} mode, found: ${qualifierToString(def.qualifier)}`,
        children: [],
      })
    } else if (generalMode === def.qualifier) {
      this.suggestions.set(def.id, mode)
    }
  }
}

class ModeFinderVisitor implements EffectVisitor {
  public currentMode: OpQualifier = 'pureval'

  exitConcrete(effect: ConcreteEffect) {
    let mode: OpQualifier
    if (isAction(effect)) {
      mode = 'action'
    } else if (isTemporal(effect)) {
      mode = 'temporal'
    } else if (isState(effect)) {
      mode = 'val'
    } else {
      mode = 'pureval'
    }

    this.currentMode = commonMode(this.currentMode, mode)
  }

  exitArrow(effect: ArrowEffect) {
    const r = effect.result
    if (r.kind === 'arrow') {
      throw new Error(`Unexpected arrow found in operator result: ${effectToString(r)}`)
    }

    this.currentMode = 'puredef'

    if (r.kind === 'quantified') {
      return
    }

    const [paramReads, paramUpdates, paramTemporals] = paramVariablesByEffect(effect)

    if (anyVariablesAdded(paramTemporals, r.temporal)) {
      this.currentMode = 'temporal'
    } else if (anyVariablesAdded(paramUpdates, r.update)) {
      this.currentMode = 'action'
    } else if (anyVariablesAdded(paramReads, r.read)) {
      this.currentMode = 'def'
    }
  }
}

/*
 * If there is a variable with an effect in the results that is not present on the
 * parameters, then the operator is adding that and this should
 * promote the operators mode.
 *
 * For example, an operator with the effect `(Read[v]) => Read[v, 'x']` is adding `Read['x']`
 * to the parameter effect and should be promoted to `def`.
 */
function anyVariablesAdded(paramVariables: Variables[], resultVariables: Variables): boolean {
  switch (resultVariables.kind) {
    case 'union':
      return resultVariables.variables.length > 0
        && !resultVariables.variables.every(v => paramVariables.some(p => isEqual(p, v)))
    case 'concrete':
      return resultVariables.vars.length > 0 && !paramVariables.some(p => isEqual(p, resultVariables))
    case 'quantified':
      return !paramVariables.some(p => isEqual(p, resultVariables))
  }
}

function paramVariablesByEffect(effect: ArrowEffect): [Variables[], Variables[], Variables[]] {
  const paramReads: Variables[] = []
  const paramUpdates: Variables[] = []
  const paramTemporals: Variables[] = []

  effect.params.forEach(p => {
    if (p.kind === 'concrete') {
      paramReads.push(...collectVariables(p.read))
      paramUpdates.push(...collectVariables(p.update))
      paramTemporals.push(...collectVariables(p.temporal))
    }
  })

  return [paramReads, paramUpdates, paramTemporals]
}

function collectVariables(v: Variables): Variables[] {
  if (v.kind === 'union') {
    return v.variables
  } else {
    return [v]
  }
}

const modeOrder =
  ['pureval', 'puredef', 'val', 'def', 'nondet', 'action', 'temporal']

function commonMode(m1: OpQualifier, m2: OpQualifier): OpQualifier {
  const p1 = modeOrder.findIndex(elem => elem === m1)
  const p2 = modeOrder.findIndex(elem => elem === m2)

  return p1 > p2 ? m1 : m2
}
