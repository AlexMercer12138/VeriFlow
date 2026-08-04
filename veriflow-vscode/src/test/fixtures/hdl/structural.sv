`timescale 1ns/1ps

module child #(
    parameter WIDTH = 8
) (
    input  logic             clk,
    input  logic [WIDTH-1:0] data_i,
    output logic [WIDTH-1:0] data_o
);
endmodule

module top(input logic clk, input logic [7:0] source, output logic [7:0] sink);
    wire [7:0] linked;
    child #(.WIDTH(8)) u_child (
        .clk,
        .data_i(source),
        .data_o(linked)
    );
    child u_pair_a (.clk(clk)), u_pair_b (.clk(clk));
    assign sink = linked;
endmodule

module legacy(clk, data_o);
    input clk;
    output [3:0] data_o;
endmodule

interface bus_if(input logic clk);
    logic data;
endinterface

package widths_pkg;
    localparam int DEFAULT_WIDTH = 8;
endpackage
