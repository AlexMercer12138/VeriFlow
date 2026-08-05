`include "schematic-child.svh"

module included_child (
    input  logic clk,
    input  logic enable,
    output logic done
);
endmodule

module include_top (
    input logic local_clk,
`include "schematic-ports.svh"
);
    included_child local_before (
        .clk(local_clk),
        .enable(included_enable),
        .done(included_done)
    );
`include "schematic-body.svh"
    included_child local_after (
        .clk(local_clk),
        .enable(included_enable),
        .done(included_done)
    );
    foreign_child foreign_instance (
        .clk(local_clk),
        .done(included_done)
    );
    included_child local_group_before (
        .clk(local_clk),
        .enable(included_enable),
        .done(included_done)
    ),
`include "schematic-instance-item.svh"
    local_group_after (
        .clk(local_clk),
        .enable(included_enable),
        .done(included_done)
    );
endmodule
